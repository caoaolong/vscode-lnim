const vscode = acquireVsCodeApi();
const $filesList = $("#files-list");
const $backBtn = $("#back-btn");

let files = [];

$(() => {
    vscode.postMessage({ type: "getFiles" });
});

$backBtn.on("click", () => {
    vscode.postMessage({ type: "navigate", page: "chat" });
});

function formatFileSize(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

function getFileIcon(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const iconMap = {
        'pdf': 'codicon-file-pdf',
        'doc': 'codicon-file',
        'docx': 'codicon-file',
        'xls': 'codicon-file',
        'xlsx': 'codicon-file',
        'ppt': 'codicon-file',
        'pptx': 'codicon-file',
        'txt': 'codicon-file-text',
        'md': 'codicon-markdown',
        'json': 'codicon-json',
        'xml': 'codicon-file',
        'html': 'codicon-browser',
        'css': 'codicon-file',
        'js': 'codicon-file-code',
        'ts': 'codicon-file-code',
        'py': 'codicon-file-code',
        'java': 'codicon-file-code',
        'cpp': 'codicon-file-code',
        'c': 'codicon-file-code',
        'jpg': 'codicon-file-media',
        'jpeg': 'codicon-file-media',
        'png': 'codicon-file-media',
        'gif': 'codicon-file-media',
        'svg': 'codicon-file-media',
        'mp4': 'codicon-file-media',
        'mp3': 'codicon-file-media',
        'zip': 'codicon-archive',
        'rar': 'codicon-archive',
        '7z': 'codicon-archive',
    };
    return iconMap[ext] || 'codicon-file';
}

function renderFiles() {
    $filesList.empty();
    
    if (files.length === 0) {
        const $empty = $("<div>").addClass("empty-state");
        $empty.append($("<span>").addClass("codicon codicon-file"));
        $empty.append($("<div>").text("暂无接收的文件"));
        $filesList.append($empty);
        return;
    }

    files.forEach(file => {
        const $item = $("<div>").addClass("file-item");
        
        // File icon
        const $icon = $("<div>").addClass("file-icon");
        $icon.append($("<span>").addClass(`codicon ${getFileIcon(file.name)}`));
        $item.append($icon);

        // File info
        const $info = $("<div>").addClass("file-info");
        const $name = $("<div>").addClass("file-name").text(file.name);
        const $meta = $("<div>").addClass("file-meta");
        
        const $path = $("<span>").text(`路径: ${file.path}`);
        const $sender = $("<span>").text(`发送人: ${file.sender || 'Unknown'}`);
        const $size = $("<span>").addClass("file-size").text(`大小: ${formatFileSize(file.size)}`);
        
        $meta.append($path).append($sender).append($size);
        $info.append($name).append($meta);
        $item.append($info);

        // Actions
        const $actions = $("<div>").addClass("file-actions");
        
        const $openBtn = $("<button>").addClass("icon-btn").attr("title", "打开文件").on("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "openFile", file: file });
        });
        $openBtn.append($("<span>").addClass("codicon codicon-go-to-file"));

        const $delBtn = $("<button>").addClass("icon-btn delete-btn").attr("title", "删除文件").on("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "deleteFile", file: file });
        });
        $delBtn.append($("<span>").addClass("codicon codicon-trash"));

        $actions.append($openBtn).append($delBtn);
        $item.append($actions);

        $filesList.append($item);
    });
}

window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
        case "updateFiles":
            files = message.files || [];
            renderFiles();
            break;
    }
});

