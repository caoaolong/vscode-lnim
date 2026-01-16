const vscode = acquireVsCodeApi();
const $nicknameInput = $("#nickname");
const $ipInput = $("#ip-address");
const $portInput = $("#port");
const $saveBtn = $("#save-btn");
const $backBtn = $("#back-btn");

let currentUserSettings = {
    nickname: "User",
    ip: "",
    port: 18080
};

$(document).ready(() => {
    vscode.postMessage({ type: "getSettings" });
    vscode.postMessage({ type: "getLocalIps" });
});

$backBtn.on("click", () => {
    vscode.postMessage({ type: "navigate", page: "chat" });
});

$saveBtn.on("click", () => {
    let port = 18080;
    const v = $portInput.val().trim();
    if (v) {
        const n = parseInt(v, 10);
        if (n > 0 && n <= 65535) {
            port = n;
        }
    }
    const newSettings = {
        nickname: $nicknameInput.val().trim() || "User",
        ip: $ipInput.val().trim(),
        port: port
    };
    vscode.postMessage({ type: "saveSettings", settings: newSettings });
    vscode.postMessage({ type: "navigate", page: "chat" });
});

window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
        case "updateSettings":
            currentUserSettings = message.settings;
            $nicknameInput.val(currentUserSettings.nickname);
            $portInput.val(currentUserSettings.port);
            // IP might be set after localIps are loaded
            if ($ipInput.find("option").length > 0) {
                 $ipInput.val(currentUserSettings.ip);
            }
            break;
        case "localIps":
            $ipInput.empty();
            if (message.ips && message.ips.length > 0) {
                message.ips.forEach(ip => {
                    $ipInput.append(new Option(ip, ip));
                });
                if (currentUserSettings.ip) {
                    $ipInput.val(currentUserSettings.ip);
                }
            }
            break;
    }
});