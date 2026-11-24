import "dotenv/config";

import express from "express";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import {
    readFile,
    writeFile,
    rename,
    chmod,
} from "node:fs/promises";

// ==========================================
// INITIALIZATION
// ==========================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN_FILE = path.join(__dirname, "tokens.json");

const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({
    server,
    path: "/ws"
});

const CONFIG = {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI,
    port: 6776,
    pollingInterval: 1000
};

if (
    !CONFIG.clientId ||
    !CONFIG.clientSecret ||
    !CONFIG.redirectUri
) {
    throw new Error("Required variables are missing from the .env file");
}

// ==========================================
// EXPRESS CONFIGURATION
// ==========================================

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.static(path.join(__dirname, "public")));

app.disable("x-powered-by");

// ==========================================
// STATE
// ==========================================

let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;

let pollingTimer = null;
let polling = false;
let retryAfter = 0;

let currentTrack = {
    connected: false,
    status: "disconnected",
    isPlaying: false,
    track: null,
    progressMs: 0,
    durationMs: 0,
    message: "Connect Spotify"
};

// ==========================================
// UTILS
// ==========================================

function generateRandomString(length = 32) {
    return crypto.randomBytes(length).toString("hex").slice(0, length);
}

function broadcast(data) {
    const message = JSON.stringify({
        type: "now-playing",
        data
    });

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function updateState(data) {
    currentTrack = {
        ...data,
        receivedAt: Date.now()
    };

    broadcast(currentTrack);
}

async function saveTokens() {
    if (!refreshToken) return;

    const tempFile = `${TOKEN_FILE}.tmp`;

    const data = {
        refresh_token: refreshToken,
    };

    await writeFile(
        tempFile,
        JSON.stringify(data, null, 2),
        { mode: 0o600 }
    );

    await rename(tempFile, TOKEN_FILE);

    await chmod(TOKEN_FILE, 0o600);
}

async function loadTokens() {
    try {
        const content = await readFile(TOKEN_FILE, "utf8");
        const data = JSON.parse(content);

        if (!data.refresh_token) {
            throw new Error("Missing refresh_token in the file.");
        }

        refreshToken = data.refresh_token;

        await refreshAccessToken();

        console.log("[Spotify] The session has been restored.");
        return true;
    } catch (error) {
        if (error.code === "ENOENT") {
            console.log("[Spotify] No saved session.");
            return false;
        }

        console.error("[Spotify] Failed to restore the session:", error.message);
        return false;
    }
}

// ==========================================
// SPOTIFY OAUTH
// ==========================================

let oauthState = null;

app.get("/login", (_, res) => {
    oauthState = generateRandomString(32);

    const params = new URLSearchParams({
        client_id: CONFIG.clientId,
        response_type: "code",
        redirect_uri: CONFIG.redirectUri,
        scope: "user-read-currently-playing",
        state: oauthState
    });

    res.redirect(
        `https://accounts.spotify.com/authorize?${params.toString()}`
    );
});

async function exchangeToken(code) {
    const credentials = Buffer.from(
        `${CONFIG.clientId}:${CONFIG.clientSecret}`
    ).toString("base64");

    const response = await fetch(
        "https://accounts.spotify.com/api/token",
        {
            method: "POST",
            headers: {
                Authorization: `Basic ${credentials}`,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: CONFIG.redirectUri
            })
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.error_description || data.error || "Token exchange failed"
        );
    }

    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
}

async function refreshAccessToken() {
    if (!refreshToken) {
        throw new Error("Missing refresh_token.");
    }

    const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            Authorization: `Basic ${Buffer.from(
                `${CONFIG.clientId}:${CONFIG.clientSecret}`
            ).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        }),
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error_description || data.error || "Token refresh failed.");
    }

    accessToken = data.access_token;

    if (data.refresh_token) {
        refreshToken = data.refresh_token;
    }

    await saveTokens();

    return accessToken;
}

async function getValidToken() {
    if (!accessToken) {
        throw new Error("Spotify not connected");
    }

    if (Date.now() >= tokenExpiresAt - 60000) {
        await refreshAccessToken();
    }

    return accessToken;
}

app.get("/callback", async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        return res.status(400).send(`Spotify error: ${error}`);
    }

    if (
        typeof code !== "string" ||
        typeof state !== "string" ||
        !oauthState ||
        state !== oauthState
    ) {
        return res.status(400).send("Invalid OAuth state");
    }

    oauthState = null;

    try {
        await exchangeToken(code);

        await saveTokens();

        updateState({
            connected: true,
            status: "idle",
            isPlaying: false,
            track: null,
            progressMs: 0,
            durationMs: 0,
            message: "Spotify connected"
        });

        startPolling();

        res.redirect("/");
    } catch (error) {
        console.error("[OAuth]", error);
        res.status(500).send("Spotify authorization failed");
    }
});

// ==========================================
// SPOTIFY API
// ==========================================

async function getCurrentlyPlaying() {
    let token = await getValidToken();

    let response = await fetch(
        "https://api.spotify.com/v1/me/player/currently-playing",
        {
            headers: {
                Authorization: `Bearer ${token}`
            }
        }
    );

    // Token expired or invalid - refresh and retry once
    if (response.status === 401) {
        await refreshAccessToken();
        token = accessToken;

        response = await fetch(
            "https://api.spotify.com/v1/me/player/currently-playing",
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );
    }

    if (response.status === 204) {
        return null;
    }

    if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After") || 5);

        retryAfter = Date.now() + seconds * 1000;

        console.warn(`[Spotify] Rate limited. Retry in ${seconds}s`);

        return undefined;
    }

    if (!response.ok) {
        throw new Error(`Spotify API: HTTP ${response.status}`);
    }

    return await response.json();
}

function normalizeTrack(data) {
    if (!data?.item) {
        return {
            connected: true,
            status: "idle",
            isPlaying: false,
            track: null,
            progressMs: 0,
            durationMs: 0,
            message: "Nothing is playing"
        };
    }

    const item = data.item;

    const images = item.album?.images || item.images || [];

    const artwork = images.length
        ? [...images].sort(
            (a, b) => (b.width || 0) - (a.width || 0)
        )[0].url
        : null;

    return {
        connected: true,
        status: data.is_playing ? "playing" : "paused",
        isPlaying: Boolean(data.is_playing),

        track: {
            id: item.id,
            name: item.name,
            artist: item.artists?.map(a => a.name).join(", ")
                || item.show?.name
                || "Unknown artist",
            album: item.album?.name || item.show?.name || "",
            artwork,
            url: item.external_urls?.spotify || null
        },

        progressMs: data.progress_ms || 0,
        durationMs: item.duration_ms || 0,

        message: data.is_playing
            ? "Now playing"
            : "Playback paused"
    };
}

// ==========================================
// POLLING
// ==========================================

async function pollSpotify() {
    if (polling || !accessToken) return;
    if (Date.now() < retryAfter) return;

    polling = true;

    try {
        const data = await getCurrentlyPlaying();

        if (data === undefined) return;

        updateState(
            data === null
                ? normalizeTrack(null)
                : normalizeTrack(data)
        );

    } catch (error) {
        console.error("[Polling]", error.message);

        updateState({
            ...currentTrack,
            status: "error",
            message: error.message
        });

    } finally {
        polling = false;
    }
}

function startPolling() {
    if (pollingTimer) {
        clearInterval(pollingTimer);
    }

    pollSpotify();

    pollingTimer = setInterval(
        pollSpotify,
        CONFIG.pollingInterval
    );
}

// ==========================================
// WEBSOCKET
// ==========================================

wss.on("connection", socket => {
    console.log("[WebSocket] Client connected");

    socket.send(JSON.stringify({
        type: "now-playing",
        data: currentTrack
    }));

    socket.on("close", () => {
        console.log("[WebSocket] Client disconnected");
    });
});

// ==========================================
// ROUTES
// ==========================================

// Main overlay

app.get("/", (_, res) => {
    res.render("index", {
        title: "Spotify Overlay"
    });
});

// API status

app.get("/api/status", (_, res) => {
    res.json(currentTrack);
});

// ==========================================
// SERVER
// ==========================================

server.listen(CONFIG.port, "127.0.0.1", async () => {
    const restored = await loadTokens();

    if (restored) {
        startPolling();
    } else {
        console.log("[Spotify] Log in via /login");
    }

    console.log("");
    console.log("==================================");
    console.log(" Spotify Now Playing Overlay");
    console.log("==================================");
    console.log("");
    console.log(`Overlay:   http://127.0.0.1:${CONFIG.port}/`);
    console.log(`Login:     http://127.0.0.1:${CONFIG.port}/login`);
    console.log("");
});
