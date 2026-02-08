const vscode = acquireVsCodeApi();
const $localFilesList = $("#local-files-list");
const $receivedFilesList = $("#received-files-list");
const $backBtn = $("#back-btn");
const $addLocalFileBtn = $("#add-local-file-btn");
const $tooltip = $("#tooltip");
const $qrOverlay = $("#qr-modal-overlay");
const $qrModalImg = $("#qr-modal-img");
const $qrModalTitle = $("#qr-modal-title");
const $qrModalClose = $("#qr-modal-close");

let localFiles = [];
let receivedFiles = [];
let activeTab = "local";

$(() => {
  vscode.postMessage({ type: "getFiles" });
  vscode.postMessage({ type: "getLocalFiles" });
});

$backBtn.on("click", () => {
  vscode.postMessage({ type: "navigate", page: "chat" });
});

$addLocalFileBtn.on("click", () => {
  vscode.postMessage({ type: "addLocalFiles" });
});

$(".files-tab").on("click", function () {
  const tab = $(this).data("tab");
  activeTab = tab;
  $(".files-tab").removeClass("active");
  $(this).addClass("active");
  $(".files-tab-content").removeClass("active");
  if (tab === "local") {
    $("#local-files-content").addClass("active");
  } else {
    $("#received-files-content").addClass("active");
  }
});

function showQrModal(dataUrl, fileName) {
  $qrModalTitle.text(fileName || "二维码");
  $qrModalImg.attr("src", dataUrl);
  $qrOverlay.addClass("show");
}

function hideQrModal() {
  $qrOverlay.removeClass("show");
  $qrModalImg.attr("src", "");
}

$qrModalClose.on("click", hideQrModal);
$qrOverlay.on("click", function (e) {
  if (e.target === this) hideQrModal();
});

function positionTooltip(e) {
  const offset = 10;
  $tooltip.css({
    left: e.pageX + offset,
    top: e.pageY + offset,
  });
}

function formatFileSize(bytes) {
  if (bytes === 0) {
    return "0 B";
  }
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

function getFileIcon(fileName) {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const iconMap = {
    pdf: "codicon-file-pdf",
    doc: "codicon-file",
    docx: "codicon-file",
    xls: "codicon-file",
    xlsx: "codicon-file",
    ppt: "codicon-file",
    pptx: "codicon-file",
    txt: "codicon-file-text",
    md: "codicon-markdown",
    json: "codicon-json",
    xml: "codicon-file",
    html: "codicon-browser",
    css: "codicon-file",
    js: "codicon-file-code",
    ts: "codicon-file-code",
    py: "codicon-file-code",
    java: "codicon-file-code",
    cpp: "codicon-file-code",
    c: "codicon-file-code",
    jpg: "codicon-file-media",
    jpeg: "codicon-file-media",
    png: "codicon-file-media",
    gif: "codicon-file-media",
    svg: "codicon-file-media",
    mp4: "codicon-file-media",
    mp3: "codicon-file-media",
    zip: "codicon-archive",
    rar: "codicon-archive",
    "7z": "codicon-archive",
  };
  return iconMap[ext] || "codicon-file";
}

function buildFileItem(file, options) {
  const { isLocal = false } = options || {};
  const $item = $("<div>").addClass("file-item");
  const $icon = $("<div>").addClass("file-icon");
  $icon.append($("<span>").addClass(`codicon ${getFileIcon(file.name)}`));
  $icon.on("mouseenter", function (e) {
    $tooltip.text(file.path).show();
    positionTooltip(e);
  });
  $icon.on("mousemove", positionTooltip);
  $icon.on("mouseleave", () => $tooltip.hide());
  $item.append($icon);

  const $info = $("<div>").addClass("file-info");
  const $name = $("<div>").addClass("file-name").text(file.name);
  const $meta = $("<div>").addClass("file-meta");
  if (isLocal) {
    $meta.append(
      $("<span>")
        .addClass("file-size")
        .text(`大小: ${formatFileSize(file.size)}`)
    );
  } else {
    $meta
      .append($("<span>").text(`发送人: ${file.sender || "Unknown"}`))
      .append(
        $("<span>")
          .addClass("file-size")
          .text(`大小: ${formatFileSize(file.size)}`)
      );
  }
  $info.append($name).append($meta);
  $item.append($info);

  const $actions = $("<div>").addClass("file-actions");

  const $openBtn = $("<button>")
    .addClass("icon-btn")
    .attr("title", "打开文件")
    .on("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "openFile", file });
    });
  $openBtn.append($("<span>").addClass("codicon codicon-go-to-file"));

  const $qrBtn = $("<button>")
    .addClass("icon-btn")
    .attr("title", "二维码")
    .on("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "generateQrCode", file });
    });
  $qrBtn.append($("<span>").addClass("codicon codicon-link-external"));

  const $delBtn = $("<button>")
    .addClass("icon-btn delete-btn")
    .attr("title", isLocal ? "从列表移除" : "删除文件")
    .on("click", (e) => {
      e.stopPropagation();
      if (isLocal) {
        vscode.postMessage({ type: "deleteLocalFile", file });
      } else {
        vscode.postMessage({ type: "deleteFile", file });
      }
    });
  $delBtn.append($("<span>").addClass("codicon codicon-trash"));

  $actions.append($openBtn).append($qrBtn).append($delBtn);
  $item.append($actions);
  return $item;
}

function renderLocalFiles() {
  $localFilesList.empty();
  if (localFiles.length === 0) {
    const $empty = $("<div>").addClass("empty-state");
    $empty.append($("<span>").addClass("codicon codicon-file"));
    $empty.append($("<div>").text("暂无本地文件，点击右上角添加"));
    $localFilesList.append($empty);
    return;
  }
  localFiles.forEach((file) => {
    $localFilesList.append(buildFileItem(file, { isLocal: true }));
  });
}

function renderReceivedFiles() {
  $receivedFilesList.empty();
  if (receivedFiles.length === 0) {
    const $empty = $("<div>").addClass("empty-state");
    $empty.append($("<span>").addClass("codicon codicon-file"));
    $empty.append($("<div>").text("暂无接收的文件"));
    $receivedFilesList.append($empty);
    return;
  }
  receivedFiles.forEach((file) => {
    $receivedFilesList.append(buildFileItem(file, { isLocal: false }));
  });
}

window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "updateFiles":
      receivedFiles = message.files || [];
      renderReceivedFiles();
      break;
    case "updateLocalFiles":
      localFiles = message.files || [];
      renderLocalFiles();
      break;
    case "qrCodeDataUrl":
      showQrModal(message.dataUrl, message.fileName);
      break;
    case "qrCodeError":
      hideQrModal();
      break;
  }
});
