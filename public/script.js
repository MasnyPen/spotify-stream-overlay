let playback = null;

let anchorProgress = 0;
let anchorTime = Date.now();

const $ = id => document.getElementById(id);

function formatTime(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(seconds / 60);

    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function render(data) {
    playback = data;

    anchorProgress = data.progressMs || 0;
    anchorTime = Date.now();

    if (!data.track) {
        $("title").textContent = data.message || "Nothing is playing";
        $("artist").textContent = "Spotify";
        $("album").textContent = "";

        $("progress").style.width = "0%";
        $("elapsed").textContent = "0:00";
        $("remaining").textContent = "−0:00";

        $("pauseIndicator").classList.remove("visible");

        return;
    }

    const track = data.track;

    $("title").textContent = track.name;
    $("artist").textContent = track.artist;
    $("album").textContent = track.album || "";

    if (track.artwork) {
        $("cover").src = track.artwork;
    }

    $("pauseIndicator").classList.toggle("visible", !data.isPlaying);

    updateProgress();
}

function updateProgress() {
    if (!playback?.track) return;

    const duration = playback.durationMs || 0;

    let elapsed = anchorProgress;

    if (playback.isPlaying) {
        elapsed += Date.now() - anchorTime;
    }

    elapsed = Math.min(elapsed, duration);

    const remaining = Math.max(0, duration - elapsed);

    const percentage = duration > 0 ? elapsed / duration * 100 : 0;

    $("progress").style.width = `${percentage}%`;
    $("elapsed").textContent = formatTime(elapsed);
    $("remaining").textContent = `−${formatTime(remaining)}`;
}

function connectWebSocket() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";

    const socket = new WebSocket(
        `${protocol}//${location.host}/ws`
    );

    socket.onmessage = event => {
        try {
            const message = JSON.parse(event.data);

            if (message.type === "now-playing") {
            render(message.data);
            }
        } catch (error) {
            console.error(error);
        }
    };

    socket.onclose = () => {
        setTimeout(connectWebSocket, 1500);
    };

    socket.onerror = () => socket.close();
}

connectWebSocket();

setInterval(updateProgress, 250);