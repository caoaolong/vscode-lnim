const vscode = acquireVsCodeApi();
const $contactsList = $("#contacts-list");
const $contactIpInput = $("#contact-ip");
const $scanContactsBtn = $("#scan-contacts-btn");
const $backBtn = $("#back-btn");

let contacts = [];
let hasAutoChecked = false;

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

        // Avatar
        const $avatar = $("<div>").addClass("contact-avatar");
        $avatar.append($("<span>").addClass("codicon codicon-account"));
        $item.append($avatar);

        // Info
        const $infoDiv = $("<div>").addClass("contact-info");
        const $nameDiv = $("<div>").addClass("contact-name").text(c.username || "Unknown");
        const $hostDiv = $("<div>").addClass("contact-host").text(host);
        $infoDiv.append($nameDiv).append($hostDiv);
        $item.append($infoDiv);

        // Right side container for status and actions
        const $rightSide = $("<div>").addClass("contact-right");

        // Status
        const $statusDiv = $("<div>").addClass("contact-status");
        const $statusDot = $("<span>").addClass("status-dot " + (isOnline ? "online" : "offline"));
        // Remove text status to save space, rely on dot color
        // const $statusText = $("<span>").addClass("status-text").text(isOnline ? "Online" : "Offline");
        $statusDiv.append($statusDot);
        $statusDiv.attr("title", isOnline ? "Online" : "Offline");
        $rightSide.append($statusDiv);

        // Actions
        const $actionsDiv = $("<div>").addClass("contact-actions");
        
        const $clearBtn = $("<button>").addClass("icon-btn warning-btn").attr("title", "Clear Chat History").on("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "deleteRecord", contact: c });
        });
        $clearBtn.append($("<span>").addClass("codicon codicon-clear-all"));

        const $delBtn = $("<button>").addClass("icon-btn delete-btn").attr("title", "Delete Contact").on("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "deleteContact", contact: c });
        });
        $delBtn.append($("<span>").addClass("codicon codicon-trash"));

        $actionsDiv.append($clearBtn).append($delBtn);
        $rightSide.append($actionsDiv);

        $item.append($rightSide);
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
            if (!hasAutoChecked && contacts.length > 0) {
                contacts.forEach(c => {
                    vscode.postMessage({ type: "checkContactLink", contact: c });
                });
                hasAutoChecked = true;
            }
            break;
    }
});
