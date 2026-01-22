const vscode = acquireVsCodeApi();
const $chatBox = $("#chat-box");
const $input = $("#message-input");
const $mentionSuggest = $("#mention-suggest");
const $contactSelect = $("#contact-select");
const $targetTagsContainer = $("#target-tags-container");
const $fileBtn = $("#file-btn");
const $settingsBtn = $("#settings-btn");
const $contactsBtn = $("#contacts-btn");
const $filesBtn = $("#files-btn");
const $currentUsername = $("#current-username");
const $currentStatusDot = $("#current-status-dot");

let currentUserSettings = {
  nickname: "User",
  ip: "",
  port: 18080,
};
let isOnline = false; // TCP服务器在线状态
let lastMessageTime = 0;
let contacts = [];
let allContacts = [];
let selectedContacts = [];
let mentionActive = false;
let mentionQuery = "";
let mentionItems = [];
let mentionIndex = -1;
let mentionTrigger = "";
let currentBrowsePath = "";
let directoryItems = [];

// Initialize
$(() => {
  vscode.postMessage({ type: "getSettings" });
  vscode.postMessage({ type: "getContacts" });
  vscode.postMessage({ type: "getChatHistory" });
  vscode.postMessage({ type: "getServerStatus" }); // 请求服务器状态
  renderUserStatus(); // 初始化用户状态显示
});

// --- Event Listeners ---

$settingsBtn.on("click", () => {
  vscode.postMessage({ type: "navigate", page: "settings" });
});

$contactsBtn.on("click", () => {
  vscode.postMessage({ type: "navigate", page: "contacts" });
});

$filesBtn.on("click", () => {
  vscode.postMessage({ type: "navigate", page: "files" });
});

$input.on("keydown", (e) => {
  if (mentionActive) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (mentionItems.length) {
        mentionIndex = (mentionIndex + 1) % mentionItems.length;
        renderMention();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (mentionItems.length) {
        mentionIndex =
          (mentionIndex - 1 + mentionItems.length) % mentionItems.length;
        renderMention();
      }
      return;
    }
    if (e.key === "ArrowRight") {
      if (mentionTrigger === "#" && mentionItems.length && mentionIndex >= 0) {
        const item = mentionItems[mentionIndex];
        if (item.type === "folder") {
          e.preventDefault();
          currentBrowsePath = item.value;
          mentionQuery = "";
          vscode.postMessage({
            type: "getDirectoryContent",
            path: currentBrowsePath,
          });
          return;
        }
      }
    }
    if (e.key === "ArrowLeft") {
      if (mentionTrigger === "#" && currentBrowsePath) {
        e.preventDefault();
        const parts = currentBrowsePath.split("/").filter((x) => x);
        if (parts.length > 0) {
          parts.pop();
        }
        currentBrowsePath = parts.join("/");
        mentionQuery = "";
        vscode.postMessage({
          type: "getDirectoryContent",
          path: currentBrowsePath,
        });
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (mentionIndex >= 0 && mentionIndex < mentionItems.length) {
        applyMention(mentionItems[mentionIndex]);
        closeMention();
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const message = buildMessageText().trim();
    if (message) {
      if (sendMessage(message)) {
        $input.html("");
        closeMention();
			}
			return;
		}
  }
  if (e.key === "#") {
    setTimeout(() => {
      openMentionIfNeeded();
    }, 0);
  }
  if (e.key === "Backspace") {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      if (range.collapsed) {
        let container = range.startContainer;
        let offset = range.startOffset;
        if (container.nodeType === Node.TEXT_NODE) {
          if (offset === 0) {
            const prev = container.previousSibling;
            if (
              prev &&
              prev.nodeType === Node.ELEMENT_NODE &&
              prev.classList &&
              prev.classList.contains("mention-tag")
            ) {
              e.preventDefault();
              $(prev).remove();
              return;
            }
          }
        } else if (container.nodeType === Node.ELEMENT_NODE) {
          const el = container;
          const prev = el.childNodes[offset - 1];
          if (
            prev &&
            prev.nodeType === Node.ELEMENT_NODE &&
            prev.classList &&
            prev.classList.contains("mention-tag")
          ) {
            e.preventDefault();
            $(prev).remove();
            return;
          }
        }
      }
    }
  }
});

$input.on("input", () => {
  if (!mentionActive) {
    openMentionIfNeeded();
    return;
  }
  const q = getCurrentMentionQuery();
  if (q === null) {
    closeMention();
  } else {
    mentionQuery = q;
    filterMention();
  }
});

$fileBtn.on("click", () => {
  vscode.postMessage({ type: "selectFile" });
});

function insertTagAtCursor(item) {
  const tag = createMentionTag(item, { closable: true, source: "input" });
  $input.focus();
  const sel = window.getSelection();
  if (sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(tag[0]);
    range.collapse(false);
    const space = document.createTextNode(" ");
    range.insertNode(space);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    $input.append(tag);
    $input.append(document.createTextNode(" "));
    placeCaretAtEnd($input[0]);
  }
}

// --- Message Handling ---

window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "updateSettings":
    case "settingsSaved":
      currentUserSettings = message.settings;
      renderUserStatus();
      break;
    case "updateUserStatus":
      isOnline = message.isOnline;
      renderUserStatus();
      break;
    case "updateContacts":
    case "contactsSaved":
      contacts = message.contacts || [];
      allContacts = contacts.slice();
      renderContactSelect();
      renderTargetTags(); // 更新目标标签显示
      if (mentionActive) {
        filterMention();
      }
      break;
    case "directoryContent": {
      const pathPrefix = message.path ? message.path + "/" : "";
      directoryItems = [];
      (message.folders || []).forEach((f) => {
        directoryItems.push({
          type: "folder",
          label: f,
          value: pathPrefix + f,
        });
      });
      (message.files || []).forEach((f) => {
        directoryItems.push({ type: "file", label: f, value: pathPrefix + f });
      });

      if (mentionActive && mentionTrigger === "#") {
        filterMention();
      }
      break;
    }
    case "insertPathTag":
      if (message.item) {
        insertTagAtCursor(message.item);
      }
      break;
    case "imageSelected":
      if (message.path) {
        const value = message.path;
        const label = message.label || value.split(/[\/\\]/).pop();
        let type = "file";
        if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(value)) {
          type = "image";
        }
        insertTagAtCursor({
          type,
          value,
          label,
        });
      }
      break;
    case "chatHistory": {
      const history = message.history || [];
      const selfNickname =
        message.selfNickname || currentUserSettings.nickname || "Me";
      history.forEach((record) => {
        const ts =
          typeof record.createdAt === "number" ? record.createdAt : Date.now();
        checkAndAddTimestamp(ts);
          addMessage({
            from: record.peerKey,
            text: record.content,
            isSelf: record.direction === "outgoing",
            nickname:
              record.direction === "outgoing"
                ? selfNickname
                : record.peerUsername || "Unknown",
            timestamp: ts,
          });
        lastMessageTime = ts;
      });
      break;
    }
    case "receiveMessage": {
      // 构建 from 字段：格式为 ip|port|username
      const fromKey = message.fromIp && message.fromPort 
        ? `${message.fromIp}|${message.fromPort}|${message.from || ''}`
        : undefined;
      
      addMessage({
        from: fromKey,
        text: message.message,
        files: message.files || [],
        isSelf: false,
        nickname: message.from,
        timestamp: message.timestamp,
      });
      break;
    }
  }
});

$(window).on("keydown", (e) => {
  if (e.key === "Escape") {
    if (mentionActive) {
      closeMention();
    }
  }
});

function sendMessage(text) {
  const structured = buildStructuredMessage(text);
  if (!structured.target || structured.target.length === 0) {
    vscode.postMessage({
      type: "warning",
      warningType: "noTargetSelected",
    });
    return false;
  }

  const now = Date.now();
  checkAndAddTimestamp(now);

  addMessage({
    text: text,
    isSelf: true,
    nickname: currentUserSettings.nickname,
    timestamp: now,
  });

  vscode.postMessage({
    type: "sendMessage",
    value: structured.value,
    files: structured.files,
    target: structured.target,
    timestamp: now,
    nickname: currentUserSettings.nickname,
  });

  lastMessageTime = now;
  return true;
}

function buildStructuredMessage(text) {
  const files = {};
  let fileIndex = 1;
  const value = text.replace(/\{#([^}]+)\}/g, (match, filePath) => {
    if (!filePath) {
      return match;
    }
    const key = "file" + fileIndex;
    fileIndex += 1;
    files[key] = filePath;
    return "<" + key + ">";
  });

  const targetsSet = new Set();
  const targets = [];
  (selectedContacts || []).forEach((c) => {
    if (!c || !c.ip) {
      return;
    }
    const port =
      typeof c.port === "number" && c.port > 0
        ? c.port
        : currentUserSettings.port || 0;
    const target = port > 0 ? c.ip + ":" + port : c.ip;
    if (!targetsSet.has(target)) {
      targetsSet.add(target);
      targets.push(target);
    }
  });

  return {
    value,
    files,
    target: targets,
  };
}

/**
 * 渲染目标标签（已选择的目标）
 */
function renderTargetTags() {
  if (!$targetTagsContainer || $targetTagsContainer.length === 0) {
    return;
  }
  
  $targetTagsContainer.empty();
  
  // 过滤：只显示在线的已选择联系人
  const onlineSelectedContacts = (selectedContacts || []).filter((selected) => {
    const contact = contacts.find((c) => {
      const cIp = c.ip || "";
      const cPort = typeof c.port === "number" && c.port > 0 ? c.port : 0;
      const sIp = selected.ip || "";
      const sPort = typeof selected.port === "number" && selected.port > 0 ? selected.port : 0;
      return cIp === sIp && cPort === sPort;
    });
    // 只显示在线的联系人（status为true或undefined表示在线）
    return contact && (contact.status === true || contact.status === undefined);
  });
  
  if (onlineSelectedContacts.length === 0) {
    return;
  }
  
  onlineSelectedContacts.forEach((contact) => {
    const label = contact.username || contact.ip || "未知";
    const $tag = $("<div>").addClass("target-tag");
    
    const $label = $("<span>").addClass("tag-label").text(label);
    const $close = $("<span>")
      .addClass("tag-close")
      .html('<span class="codicon codicon-close"></span>');
    
    $tag.append($label);
    $tag.append($close);
    
    // 点击关闭按钮移除目标
    $close.on("click", (e) => {
      e.stopPropagation();
      const idx = selectedContacts.findIndex((sc) => {
        const sip = sc.ip || "";
        const sport = typeof sc.port === "number" && sc.port > 0 ? sc.port : 0;
        const cip = contact.ip || "";
        const cport = typeof contact.port === "number" && contact.port > 0 ? contact.port : 0;
        return sip === cip && sport === cport;
      });
      if (idx >= 0) {
        selectedContacts.splice(idx, 1);
        renderTargetTags();
        renderContactSelect();
      }
    });
    
    $targetTagsContainer.append($tag);
  });
}

function renderContactSelect() {
  if (!$contactSelect || $contactSelect.length === 0) {
    return;
  }
  $contactSelect.empty();
  
  // 只显示在线的联系人
  const onlineContacts = (contacts || []).filter((c) => {
    return c.status === true || c.status === undefined;
  });
  
  if (onlineContacts.length === 0) {
    return;
  }
  
  const selectedKeys = new Set(
    (selectedContacts || []).map((c) => {
      const ip = c.ip || "";
      const port = typeof c.port === "number" && c.port > 0 ? c.port : 0;
      return ip + ":" + port;
    }),
  );

  onlineContacts.forEach((c) => {
    const ip = c.ip || "";
    const port = typeof c.port === "number" && c.port > 0 ? c.port : 0;
    const key = ip + ":" + port;
    const label = c.username || c.ip || "";

    const $item = $("<div>").addClass("contact-select-item").text(label);
    if (selectedKeys.has(key)) {
      $item.addClass("selected");
    }

    $item.on("click", () => {
      const idx = selectedContacts.findIndex((sc) => {
        const sip = sc.ip || "";
        const sport = typeof sc.port === "number" && sc.port > 0 ? sc.port : 0;
        return sip === ip && sport === port;
      });
      if (idx >= 0) {
        selectedContacts.splice(idx, 1);
        $item.removeClass("selected");
      } else {
        selectedContacts.push({
          ip: c.ip,
          port: c.port,
          username: c.username,
        });
        $item.addClass("selected");
      }
      // 更新目标标签显示
      renderTargetTags();
    });

    $contactSelect.append($item);
  });
}

/**
 * 渲染用户状态（右下角显示）
 * 显示当前用户名和在线状态（基于TCP服务器状态）
 */
function renderUserStatus() {
  // 更新用户名
  const nickname = currentUserSettings?.nickname || "User";
  $currentUsername.text(nickname);
  
  // 更新在线状态指示器
  if (isOnline) {
    $currentStatusDot.removeClass("offline").addClass("online");
    $currentStatusDot.attr("title", "在线 (TCP服务已启动)");
  } else {
    $currentStatusDot.removeClass("online").addClass("offline");
    $currentStatusDot.attr("title", "离线 (TCP服务未启动)");
  }
}

function checkAndAddTimestamp(currentTimestamp) {
  if (currentTimestamp - lastMessageTime > 10 * 60 * 1000) {
    const date = new Date(currentTimestamp);
    const timeString = date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    const $div = $("<div>").addClass("timestamp").text(timeString);
    $chatBox.append($div);
  }
}

function addMessage({ from, text, isSelf, nickname, files }) {
  const $container = $("<div>").addClass(
    "message-container" + (isSelf ? " self" : " other"),
  );

  const $nicknameDiv = $("<div>").addClass("nickname").text(nickname);

  const $messageDiv = $("<div>").addClass("message");
  renderMessageContent($messageDiv[0], text, from, files);

  $container.append($nicknameDiv).append($messageDiv);

  $chatBox.append($container);
  $chatBox.scrollTop($chatBox[0].scrollHeight);
}

function renderMessageContent(container, text, from, files) {
  const $container = $(container);
  $container.empty();
  
  // 辅助函数：获取文件信息
  function getFileInfo(filePath) {
    if (!filePath) return null;
    const label = filePath.split(/[\/\\]/).pop();
    return { type: "file", label };
  }
  
  // 收集所有需要显示的文件（来自files数组）
  const filesSet = new Set();
  const fileInfoMap = new Map();
  if (files && Array.isArray(files) && files.length > 0) {
    files.forEach((filePath) => {
      if (!filePath) return;
      filesSet.add(filePath);
      fileInfoMap.set(filePath, getFileInfo(filePath));
    });
  }
  
  // 按文本顺序渲染：遇到{#...}时用tag替换，隐藏原始文本
  const textPattern = /\{#([^}]+)\}/g;
  let lastIndex = 0;
  let textMatch;
  const processedInText = new Set(); // 记录文本中已处理的文件

  while ((textMatch = textPattern.exec(text)) !== null) {
    // 显示{#...}之前的文本
    if (textMatch.index > lastIndex) {
      appendPlainSegment(text.slice(lastIndex, textMatch.index));
    }
    
    // 用tag替换{#...}部分，隐藏原始文本
    const filePath = textMatch[1] || "";
    if (filePath) {
      processedInText.add(filePath);
      const fileInfo = fileInfoMap.get(filePath) || getFileInfo(filePath);
      if (fileInfo) {
        const item = { type: fileInfo.type, value: filePath, label: fileInfo.label };
        const tag = createMentionTag(item, {
          closable: false,
          source: "message",
          from: from,
        });
        $container.append(tag);
      }
    }
    
    lastIndex = textPattern.lastIndex;
  }

  // 显示剩余的文本
  if (lastIndex < text.length) {
    appendPlainSegment(text.slice(lastIndex));
  }
  
  // 如果files数组中有文件但文本中没有对应的{#...}，在末尾追加这些tag
  filesSet.forEach((filePath) => {
    if (!processedInText.has(filePath)) {
      const fileInfo = fileInfoMap.get(filePath);
      if (fileInfo) {
        const item = { type: fileInfo.type, value: filePath, label: fileInfo.label };
        const tag = createMentionTag(item, {
          closable: false,
          source: "message",
          from: from,
        });
        $container.append(document.createTextNode(" "));
        $container.append(tag);
      }
    }
  });

  function appendPlainSegment(segment) {
    if (!segment) {
      return;
    }
    const parts = segment.split(/(\s+)/);
    parts.forEach((part) => {
      if (!part) {
        return;
      }
      if (/^\s+$/.test(part)) {
        $container.append(document.createTextNode(part));
        return;
      }
      $container.append(document.createTextNode(part));
    });
  }
}

function openMentionIfNeeded() {
  const q = getCurrentMentionQuery();
  if (q === null) {
    closeMention();
    return;
  }
  if (!mentionActive) {
    mentionActive = true;
    mentionIndex = -1;
    if (mentionTrigger === "#") {
      currentBrowsePath = "";
      vscode.postMessage({ type: "getDirectoryContent", path: "" });
    }
  }
  mentionQuery = q;
  filterMention();
}

function closeMention() {
  mentionActive = false;
  mentionQuery = "";
  mentionItems = [];
  mentionIndex = -1;
  mentionTrigger = "";
  currentBrowsePath = "";
  $mentionSuggest.hide().empty();
}

function getCurrentMentionQuery() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return null;
  }
  const text = $input.text();
  const caret = getCaretCharacterOffsetWithin($input[0]);
  if (caret === null) {
    return null;
  }
  const before = text.slice(0, caret);

  const hash = before.lastIndexOf("#");

  let index = -1;
  let trigger = "";

  index = hash;
  trigger = "#";

  if (index === -1) {
    return null;
  }
  if (index > 0) {
    const prev = before.charAt(index - 1);
    if (!/\s/.test(prev)) {
      return null;
    }
  }

  const query = before.slice(index + 1);
  if (/\s/.test(query)) {
    return null;
  }

  mentionTrigger = trigger;
  return query;
}

function filterMention() {
  const q = mentionQuery.toLowerCase();
  let sourceItems = [];

  if (mentionTrigger === "#") {
    sourceItems = directoryItems;
  }

  mentionItems = sourceItems.filter(
    (it) => !q || it.label.toLowerCase().includes(q),
  );
  if (mentionItems.length > 0 && mentionIndex === -1) {
    mentionIndex = 0;
  }
  if (mentionIndex >= mentionItems.length) {
    mentionIndex = 0;
  }
  renderMention();
}

function renderMention() {
  if (!mentionActive || mentionItems.length === 0) {
    $mentionSuggest.hide().empty();
    return;
  }
  $mentionSuggest.show().empty();

  mentionItems.slice(0, 50).forEach((it, idx) => {
    const $div = $("<div>").addClass(
      "mention-item" + (idx === mentionIndex ? " active" : ""),
    );
    const iconClass =
      it.type === "contact"
        ? "codicon-account"
        : it.type === "folder"
          ? "codicon-folder"
          : it.type === "image"
            ? "codicon-file-media"
            : "codicon-file";
    const $icon = $("<span>").addClass("codicon " + iconClass);
    const $label = $("<span>").text(it.label);
    $div.append($icon).append($label);

    if (mentionTrigger === "#" && it.type === "folder") {
      const $arrow = $("<span>")
        .addClass("codicon codicon-chevron-right")
        .css({ marginLeft: "auto", fontSize: "12px" });
      $div.append($arrow);
    }

    if (it.detail) {
      const $t = $("<span>").addClass("type").text(it.detail);
      $div.append($t);
    }

    if (mentionTrigger !== "#") {
      $div
        .on("mouseenter", () => {
          mentionIndex = idx;
          renderMention();
        })
        .on("mousedown", (e) => {
          e.preventDefault();
        })
        .on("click", () => {
          const item = mentionItems[idx];
          applyMention(item);
          closeMention();
        });
    }
    $mentionSuggest.append($div);
  });
}

function applyMention(item) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return;
  }
  let range = sel.getRangeAt(0);
  let container = range.startContainer;
  if (container.nodeType !== Node.TEXT_NODE) {
    const placeholder = document.createTextNode("");
    range.insertNode(placeholder);
    range.setStart(placeholder, 0);
    range.setEnd(placeholder, 0);
    container = placeholder;
  }
  const textNode = container;
  const beforeText = textNode.data.slice(0, range.startOffset);
  const afterText = textNode.data.slice(range.startOffset);

  const hashIndex = beforeText.lastIndexOf("#");
  const index = hashIndex;

  if (index === -1) {
    return;
  }

  const head = beforeText.slice(0, index);
  textNode.data = head;

  const tag = createMentionTag(item, { closable: true, source: "input" });

  const space = document.createTextNode(" ");
  const tail = document.createTextNode(afterText);

  if (textNode.nextSibling) {
    textNode.parentNode.insertBefore(tag[0], textNode.nextSibling);
  } else {
    textNode.parentNode.appendChild(tag[0]);
  }
  tag[0].parentNode.insertBefore(space, tag[0].nextSibling);
  space.parentNode.insertBefore(tail, space.nextSibling);

  const newRange = document.createRange();
  newRange.setStart(tail, 0);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
  $input.focus();
}

function createMentionTag(item, opts) {
  const iconClass = "codicon-file";
  const isReceived = opts && opts.source === "message" && !opts.from; // 自己发送的文件
  const isIncoming = opts && opts.source === "message" && opts.from; // 接收的文件（可能未完成）

  const $span = $("<span>")
    .addClass("mention-tag")
    .attr("data-type", item.type)
    .attr("data-value", item.value)
    .attr("data-trigger", "#");

  // 对于接收的文件，添加pending样式（可以后续通过API查询实际状态）
  if (isIncoming) {
    $span.addClass("file-pending"); // 假设未完成，点击时会触发下载
  }

  if (opts && opts.source === "input") {
    $span.attr("contenteditable", "false");
  }

  const $icon = $("<span>").addClass("codicon " + iconClass);
  const $label = $("<span>")
    .addClass("label")
    .text(item.label);

  $span.append($icon).append($label);

  if (opts && opts.closable) {
    const $close = $("<span>")
      .addClass("close codicon codicon-close")
      .attr("title", "移除")
      .on("click", (e) => {
        e.stopPropagation();
        $span.remove();
      });
    $span.append($close);
  }

  $span.on("click", (e) => {
    e.stopPropagation();
		console.log(opts);
    vscode.postMessage({
      type: "tagClicked",
      item: { type: item.type, value: item.value, label: item.label },
      from: opts && opts.from,
    });
    if (opts && opts.source === "input") {
      $input[0].focus();
    }
  });
  return $span;
}

function buildMessageText() {
  const root = $input[0];
  if (!root) {
    return "";
  }

  function collect(node) {
    if (!node) {
      return "";
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return node.data;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node;
      if (el.classList && el.classList.contains("mention-tag")) {
        const value = el.getAttribute("data-value") || "";
        if (!value) {
          return "";
        }
        return "{#" + value + "}";
      }
      let text = "";
      const children = el.childNodes;
      for (let i = 0; i < children.length; i++) {
        text += collect(children[i]);
      }
      if (el.tagName === "BR" || el.tagName === "DIV" || el.tagName === "P") {
        text += " ";
      }
      return text;
    }
    return "";
  }

  let result = "";
  const children = root.childNodes;
  for (let i = 0; i < children.length; i++) {
    result += collect(children[i]);
  }
  return result;
}

function placeCaretAtEnd(el) {
  el.focus();
  if (
    typeof window.getSelection !== "undefined" &&
    typeof document.createRange !== "undefined"
  ) {
    var range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function getCaretCharacterOffsetWithin(element) {
  var caretOffset = 0;
  var doc = element.ownerDocument || element.document;
  var win = doc.defaultView || doc.parentWindow;
  var sel;
  if (typeof win.getSelection !== "undefined") {
    sel = win.getSelection();
    if (sel.rangeCount > 0) {
      var range = win.getSelection().getRangeAt(0);
      var preCaretRange = range.cloneRange();
      preCaretRange.selectNodeContents(element);
      preCaretRange.setEnd(range.endContainer, range.endOffset);
      caretOffset = preCaretRange.toString().length;
    }
  }
  return caretOffset;
}
