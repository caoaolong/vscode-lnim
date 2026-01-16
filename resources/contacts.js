const vscode = acquireVsCodeApi();
const $contactsList = $("#contacts-list");
const $contactIpInput = $("#contact-ip");
const $scanContactsBtn = $("#scan-contacts-btn");
const $backBtn = $("#back-btn");

let contacts = [];

$(document).ready(() => {
    vscode.postMessage({ type: "getContacts" });
});

$backBtn.on("click", () => {
    vscode.postMessage({ type: "navigate", page: "chat" });
});

$scanContactsBtn.on("click", () => {
    const targetHost = $contactIpInput.val().trim();
    if (!targetHost) {
        return;
    }
    vscode.postMessage({
        type: "scanContacts",
        targetHost: targetHost
    });
});

function renderContacts() {
    $contactsList.empty();
    contacts.forEach(c => {
        const $item = $("<div>").addClass("contact-item");
        
        const host = `${c.ip}:${c.port}`;
        const isOnline = c.status === true;

        const $infoDiv = $("<div>").addClass("contact-info");
        const $nameDiv = $("<div>").addClass("contact-name").text(c.username || "Unknown");
        const $hostDiv = $("<div>").addClass("contact-host").text(host);
        $infoDiv.append($nameDiv).append($hostDiv);

        const $statusDiv = $("<div>").addClass("contact-status");
        const $statusDot = $("<span>").addClass("status-dot " + (isOnline ? "online" : "offline"));
        const $statusText = $("<span>").addClass("status-text").text(isOnline ? "Online" : "Offline");
        $statusDiv.append($statusDot).append($statusText);

        const $actionsDiv = $("<div>").addClass("contact-actions");
        
        const $checkBtn = $("<button>").addClass("icon-btn").attr("title", "Check Connection").on("click", () => {
            vscode.postMessage({ type: "checkContactLink", contact: c });
        });
        $checkBtn.append($("<span>").addClass("codicon codicon-refresh"));

        const $delBtn = $("<button>").addClass("icon-btn delete-btn").attr("title", "Delete").on("click", () => {
             vscode.postMessage({ type: "deleteContact", contact: c });
        });
        $delBtn.append($("<span>").addClass("codicon codicon-trash"));

        $actionsDiv.append($checkBtn).append($delBtn);

        $item.append($infoDiv).append($statusDiv).append($actionsDiv);
        $contactsList.append($item);
    });
}

window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
        case "updateContacts":
        case "contactsSaved":
            contacts = message.contacts || [];
            renderContacts();
            break;
    }
});