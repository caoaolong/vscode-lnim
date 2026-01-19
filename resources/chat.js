const vscode = acquireVsCodeApi();
const $chatBox = $("#chat-box");
const $input = $("#message-input");
const $mentionSuggest = $("#mention-suggest");
const $contactSelect = $("#contact-select");
const $fileBtn = $("#file-btn");
const $settingsBtn = $("#settings-btn");
const $contactsBtn = $("#contacts-btn");

let currentUserSettings = {
  nickname: "User",
  ip: "",
  port: 18080,
};
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
});

// --- Event Listeners ---

$settingsBtn.on("click", () => {
  vscode.postMessage({ type: "navigate", page: "settings" });
});

$contactsBtn.on("click", () => {
  vscode.postMessage({ type: "navigate", page: "contacts" });
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
  vscode.postMessage({ type: "selectImage" });
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
      break;
    case "updateContacts":
    case "contactsSaved":
      contacts = message.contacts || [];
      allContacts = contacts.slice();
      renderContactSelect();
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
    case "receiveMessage":
        addMessage({
          text: message.message,
          isSelf: false,
          nickname: message.from,
          timestamp: message.timestamp,
        });
      break;
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

function renderContactSelect() {
  if (!$contactSelect || $contactSelect.length === 0) {
    return;
  }
  $contactSelect.empty();
  if (!contacts || contacts.length === 0) {
    return;
  }
  const selectedKeys = new Set(
    (selectedContacts || []).map((c) => {
      const ip = c.ip || "";
      const port = typeof c.port === "number" && c.port > 0 ? c.port : 0;
      return ip + ":" + port;
    }),
  );

  contacts.forEach((c) => {
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
    });

    $contactSelect.append($item);
  });
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

function addMessage({ from, text, isSelf, nickname }) {
  const $container = $("<div>").addClass(
    "message-container" + (isSelf ? " self" : " other"),
  );

  const $nicknameDiv = $("<div>").addClass("nickname").text(nickname);

  const $messageDiv = $("<div>").addClass("message");
  renderMessageContent($messageDiv[0], text, from);

  $container.append($nicknameDiv).append($messageDiv);

  $chatBox.append($container);
  $chatBox.scrollTop($chatBox[0].scrollHeight);
}

function renderMessageContent(container, text, from) {
  const $container = $(container);
  $container.empty();
  const pattern = /\{#([^}]+)\}/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      appendPlainSegment(text.slice(lastIndex, match.index));
    }
    const filePath = match[1] || "";
    if (filePath) {
      const label = filePath.split(/[\/\\]/).pop();
      let type = "file";
      if (!filePath.includes(".")) {
        type = "folder";
      }
      if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(filePath)) {
        type = "image";
      }
      const item = { type, value: filePath, label };
      const tag = createMentionTag(item, {
        closable: false,
        source: "message",
        from: from,
      });
      $container.append(tag);
    } else {
      $container.append(document.createTextNode(match[0]));
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    appendPlainSegment(text.slice(lastIndex));
  }

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

  const $span = $("<span>")
    .addClass("mention-tag")
    .attr("data-type", item.type)
    .attr("data-value", item.value)
    .attr("data-trigger", "#");

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
    vscode.postMessage({
      type: "tagClicked",
      item: { type: item.type, value: item.value, label: item.label },
      from: opts.from,
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
