const vscode = acquireVsCodeApi();
const $nicknameInput = $("#nickname");
const $ipInput = $("#ip-address");
const $portInput = $("#port");
const $saveBtn = $("#save-btn");
const $clearHistoryBtn = $("#clear-history-btn");
const $backBtn = $("#back-btn");
const $currentAddress = $("#current-address");
const $copyAddressBtn = $("#copy-address-btn");

let currentUserSettings = {
    nickname: "User",
    ip: "",
    port: 18080
};

$(() => {
    vscode.postMessage({ type: "getSettings" });
    vscode.postMessage({ type: "getLocalIps" });
    vscode.postMessage({ type: "getServerStatus" }); // 获取实际运行的端口
});

$backBtn.on("click", () => {
    vscode.postMessage({ type: "navigate", page: "chat" });
});

// 复制地址到剪贴板
$copyAddressBtn.on("click", () => {
    const addressText = $currentAddress.text();
    
    // 使用Clipboard API复制
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(addressText).then(() => {
            showCopySuccess();
        }).catch((err) => {
            console.error("复制失败:", err);
            // 降级方案：通过VSCode命令复制
            vscode.postMessage({ 
                type: "copyToClipboard", 
                text: addressText 
            });
            showCopySuccess();
        });
    } else {
        // 降级方案
        vscode.postMessage({ 
            type: "copyToClipboard", 
            text: addressText 
        });
        showCopySuccess();
    }
});

// 显示复制成功状态
function showCopySuccess() {
    $copyAddressBtn.addClass("copied");
    $copyAddressBtn.find(".copy-btn-text").text("已复制");
    $copyAddressBtn.find(".codicon").removeClass("codicon-copy").addClass("codicon-check");
    
    setTimeout(() => {
        $copyAddressBtn.removeClass("copied");
        $copyAddressBtn.find(".copy-btn-text").text("复制");
        $copyAddressBtn.find(".codicon").removeClass("codicon-check").addClass("codicon-copy");
    }, 2000);
}

// 更新当前地址显示
function updateCurrentAddress() {
    const ip = currentUserSettings.ip || "未设置";
    const port = currentUserSettings.port || 18080;
    $currentAddress.text(`${ip}:${port}`);
}

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

$clearHistoryBtn.on("click", () => {
    vscode.postMessage({ type: "clearAllChatHistory" });
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
            updateCurrentAddress(); // 更新地址显示
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
            updateCurrentAddress(); // 更新地址显示
            break;
        case "copySuccess":
            // VSCode端复制成功的确认
            showCopySuccess();
            break;
    }
});
