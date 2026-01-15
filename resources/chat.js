const vscode = acquireVsCodeApi();
const $chatBox = $('#chat-box');
const $input = $('#message-input');
const $settingsOverlay = $('#settings-overlay');
const $nicknameInput = $('#nickname');
const $ipInput = $('#ip-address');
const $portInput = $('#port');
const $contactsOverlay = $('#contacts-overlay');
const $contactIpInput = $('#contact-ip');
const $contactsTbody = $('#contacts-tbody');
const $mentionSuggest = $('#mention-suggest');
const $imageBtn = $('#image-btn');
const $scanContactsBtn = $('#scan-contacts-btn');
const $closeContactsBtn = $('#close-contacts-btn');

let currentUserSettings = {
    nickname: 'User',
    ip: '',
    port: 18080
};
let lastMessageTime = 0;
let contacts = [];
let allContacts = [];
let filesCache = [];
let foldersCache = [];
let mentionActive = false;
let mentionQuery = '';
let mentionItems = [];
let mentionIndex = -1;
let mentionTrigger = '';
let contextMenuTarget = null;
let currentBrowsePath = '';
let directoryItems = [];
let contactStatusMap = {};
let contactsStatusRequested = false;
let localIps = [];

// --- Event Listeners ---

$scanContactsBtn.on('click', () => {
    vscode.postMessage({
        type: 'scanContacts'
    });
});

$closeContactsBtn.on('click', () => {
    $contactsOverlay.hide();
});

$input.on('keydown', (e) => {
    if (mentionActive) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (mentionItems.length) {
                mentionIndex = (mentionIndex + 1) % mentionItems.length;
                renderMention();
            }
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (mentionItems.length) {
                mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length;
                renderMention();
            }
            return;
        }
        if (e.key === 'ArrowRight') {
            if (mentionTrigger === '#' && mentionItems.length && mentionIndex >= 0) {
                const item = mentionItems[mentionIndex];
                if (item.type === 'folder') {
                    e.preventDefault();
                    // Enter folder
                    currentBrowsePath = item.value; // Full relative path
                    mentionQuery = ''; // Reset query to show all in folder
                    vscode.postMessage({ type: 'getDirectoryContent', path: currentBrowsePath });
                    // We might want to update input text to show path? 
                    // User request: "Display subdirectories, recursively".
                    // Usually this means the popup updates.
                    // If we update input text, it might interfere with "back".
                    // But let's keep input text as is (just #...) until selection.
                    // OR does user expect input to become #path/to/folder/?
                    // If I type #src, select src, press right, I see contents of src.
                    // If I then select a file, it inserts #src/file.
                    // This implies we don't necessarily update input text until final selection, 
                    // OR we do update it. 
                    // If we don't update input text, the filter uses "src" against "fileInSrc"? No.
                    // If I entered "src", filter matched "src".
                    // If I enter folder, I should probably clear the query part of input or update it?
                    // Let's assume for now we just browse in popup.
                    return;
                }
            }
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (mentionIndex >= 0 && mentionIndex < mentionItems.length) {
                applyMention(mentionItems[mentionIndex]);
                closeMention();
                return;
            }
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMention();
            return;
        }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const message = buildMessageText().trim();
        if (message) {
            sendMessage(message);
            $input.html('');
            closeMention();
        }
        return;
    }
    if (e.key === '@' || e.key === '#') {
        setTimeout(() => {
            openMentionIfNeeded();
        }, 0);
    }
    if (e.key === 'Backspace') {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            if (range.collapsed) {
                let container = range.startContainer;
                let offset = range.startOffset;
                if (container.nodeType === Node.TEXT_NODE) {
                    if (offset === 0) {
                        const prev = container.previousSibling;
                        if (prev && prev.nodeType === Node.ELEMENT_NODE && prev.classList && prev.classList.contains('mention-tag')) {
                            e.preventDefault();
                            $(prev).remove();
                            return;
                        }
                    }
                } else if (container.nodeType === Node.ELEMENT_NODE) {
                    const el = container;
                    const prev = el.childNodes[offset - 1];
                    if (prev && prev.nodeType === Node.ELEMENT_NODE && prev.classList && prev.classList.contains('mention-tag')) {
                        e.preventDefault();
                        $(prev).remove();
                        return;
                    }
                }
            }
        }
    }
});
$input.on('input', () => {
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

$imageBtn.on('click', () => {
    vscode.postMessage({ type: 'selectImage' });
});

// Drag and Drop
$input.on('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
});
$input.on('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        let path = file.path;
        if (path) {
            let type = 'file';
            if (!file.type && !path.includes('.')) type = 'folder';
            if (file.type && file.type.startsWith('image/')) type = 'image';
            const label = file.name || path.split(/[\/\\]/).pop();
            const item = { type, value: path, label: label };
            insertTagAtCursor(item);
        }
        return;
    }
    const text = e.dataTransfer.getData('text/plain');
    if (text && (text.includes('/') || text.includes('\\'))) {
        const label = text.split(/[\/\\]/).pop();
        const type = /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(text) ? 'image' : 'file';
        const item = { type, value: text, label: label };
        insertTagAtCursor(item);
    }
});

function insertTagAtCursor(item) {
     const tag = createMentionTag(item, { closable: true, source: 'input' });
     $input.focus();
     const sel = window.getSelection();
     if (sel.rangeCount > 0) {
         const range = sel.getRangeAt(0);
         range.deleteContents();
         range.insertNode(tag[0]);
         range.collapse(false);
         const space = document.createTextNode(' ');
         range.insertNode(space);
         range.collapse(false);
         sel.removeAllRanges();
         sel.addRange(range);
     } else {
         $input.append(tag);
         $input.append(document.createTextNode(' '));
         placeCaretAtEnd($input[0]);
     }
}

$('#settings-btn').on('click', () => {
    $nicknameInput.val(currentUserSettings.nickname);
    const port = currentUserSettings.port && currentUserSettings.port > 0 && currentUserSettings.port <= 65535
        ? currentUserSettings.port
        : 18080;
    $portInput.val(String(port));
    updateIpSelectOptions();
    $settingsOverlay.css('display', 'flex');
});
$('#contacts-btn').on('click', () => {
    $contactIpInput.val('');
    $contactsOverlay.css('display', 'flex');
    contactStatusMap = {};
    contactsStatusRequested = false;
    vscode.postMessage({ type: 'getContacts' });
});

$('#cancel-btn').on('click', () => {
    $settingsOverlay.hide();
});

$('#save-btn').on('click', () => {
    let port = 18080;
    const v = $portInput.val().trim();
    if (v) {
        const n = parseInt(v, 10);
        if (n > 0 && n <= 65535) {
            port = n;
        }
    }
    const newSettings = {
        nickname: $nicknameInput.val().trim() || 'User',
        ip: $ipInput.val().trim(),
        port
    };
    vscode.postMessage({ type: 'saveSettings', settings: newSettings });
    currentUserSettings = newSettings;
    $settingsOverlay.hide();
});
$('#add-contact-btn').on('click', () => {
    const host = $contactIpInput.val().trim();
    if (!host) return;
    const parts = host.split(':');
    if (parts.length !== 2) {
        window.alert('主机地址格式必须为 IP:端口');
        return;
    }
    const ip = parts[0].trim();
    const portStr = parts[1].trim();
    const port = parseInt(portStr, 10);
    if (!ip || !portStr || isNaN(port) || port <= 0 || port > 65535) {
        window.alert('主机地址格式必须为 IP:有效端口(1-65535)');
        return;
    }
    vscode.postMessage({ type: 'addContact', contact: { ip, port, username: '' }});
    $contactIpInput.val('');
});

// --- Message Handling ---

window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
        case 'updateSettings':
            currentUserSettings = message.settings;
            break;
        case 'settingsSaved':
            currentUserSettings = message.settings;
            break;
        case 'localIps':
            localIps = Array.isArray(message.ips) ? message.ips : [];
            updateIpSelectOptions();
            break;
        case 'updateContacts':
            contacts = message.contacts || [];
            allContacts = contacts.slice();
            if (mentionActive) filterMention();
            contactsStatusRequested = false;
            renderContacts();
            break;
        case 'contactsSaved':
            contacts = message.contacts || [];
            allContacts = contacts.slice();
            if (mentionActive) filterMention();
            contactsStatusRequested = false;
            renderContacts();
            break;
        case 'contactsStatus':
            contactStatusMap = {};
            (message.statuses || []).forEach(s => {
                const key = (s.ip || '') + '|' + (s.username || '');
                contactStatusMap[key] = s.online ? 'online' : 'offline';
            });
            renderContacts();
            break;
        case 'filesAndFolders':
            filesCache = message.files || [];
            foldersCache = message.folders || [];
            // We might not use this for # anymore if we use directoryContent
            break;
        case 'directoryContent': {
            const pathPrefix = message.path ? (message.path + '/') : '';
            directoryItems = [];
            // Add ".." if not root?
            if (message.path) {
                // We could add a parent entry, but user didn't explicitly ask for it.
                // But standard navigation usually has it.
                // For now, let's stick to showing folders/files.
                // To go back, maybe backspace handles it if we sync input?
                // Actually, if we are browsing, we are just changing the list content.
            }
            (message.folders || []).forEach(f => {
                directoryItems.push({ type: 'folder', label: f, value: pathPrefix + f });
            });
            (message.files || []).forEach(f => {
                directoryItems.push({ type: 'file', label: f, value: pathPrefix + f });
            });
            
            if (mentionActive && mentionTrigger === '#') {
                filterMention();
            }
            break;
        }
        case 'imageSelected':
            if (message.path) {
                insertTagAtCursor({ 
                    type: 'image', 
                    value: message.path, 
                    label: message.label || message.path.split('/').pop() 
                });
            }
            break;
        case 'receiveMessage':
            const sender = message.from || {};
            addMessage({
                text: message.message,
                isSelf: false,
                nickname: sender.nickname || 'Unknown',
                timestamp: message.timestamp
            });
            break;
    }
});

$(window).on('keydown', (e) => {
    if (e.key === 'Escape') {
        if ($settingsOverlay.css('display') === 'flex') {
            $settingsOverlay.hide();
        }
        if ($contactsOverlay.css('display') === 'flex') {
            $contactsOverlay.hide();
        }
        if (mentionActive) {
            closeMention();
        }
    }
});

function sendMessage(text) {
    const now = Date.now();
    checkAndAddTimestamp(now);
    
    addMessage({
        text: text,
        isSelf: true,
        nickname: currentUserSettings.nickname,
        timestamp: now
    });

    vscode.postMessage({ 
        type: 'sendMessage', 
        value: text,
        timestamp: now,
        nickname: currentUserSettings.nickname
    });
    
    lastMessageTime = now;
}

function checkAndAddTimestamp(currentTimestamp) {
    if (currentTimestamp - lastMessageTime > 10 * 60 * 1000) {
        const date = new Date(currentTimestamp);
        const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        const $div = $('<div>').addClass('timestamp').text(timeString);
        $chatBox.append($div);
    }
}

function addMessage({ text, isSelf, nickname }) {
    const $container = $('<div>').addClass('message-container' + (isSelf ? ' self' : ' other'));
    
    const $nicknameDiv = $('<div>').addClass('nickname').text(nickname);
    
    const $messageDiv = $('<div>').addClass('message');
    renderMessageContent($messageDiv[0], text);
    
    $container.append($nicknameDiv).append($messageDiv);
    
    $chatBox.append($container);
    $chatBox.scrollTop($chatBox[0].scrollHeight);
}
function renderMessageContent(container, text) {
    const $container = $(container);
    $container.empty();
    const parts = text.split(/(\s+)/);
    parts.forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) {
            $container.append(document.createTextNode(part));
            return;
        }
        if (part[0] === '@' && part.length > 1) {
            let name = part.slice(1);
            let suffix = '';
            const m = name.match(/^([^\s.,;:!?]+)([.,;:!?]*)$/);
            if (m) {
                name = m[1];
                suffix = m[2];
            }
            const item = resolveMentionItem(name);
            const tag = createMentionTag(item, { closable: false, source: 'message' });
            $container.append(tag);
            if (suffix) {
                $container.append(document.createTextNode(suffix));
            }
        } else {
            $container.append(document.createTextNode(part));
        }
    });
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
        if (mentionTrigger === '@') {
            vscode.postMessage({ type: 'getContacts' });
        } else if (mentionTrigger === '#') {
            currentBrowsePath = '';
            vscode.postMessage({ type: 'getDirectoryContent', path: '' });
        }
    }
    mentionQuery = q;
    filterMention();
}
function closeMention() {
    mentionActive = false;
    mentionQuery = '';
    mentionItems = [];
    mentionIndex = -1;
    mentionTrigger = '';
    currentBrowsePath = '';
    $mentionSuggest.hide().empty();
}
function getCurrentMentionQuery() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const text = $input.text();
    const caret = getCaretCharacterOffsetWithin($input[0]);
    if (caret === null) return null;
    const before = text.slice(0, caret);
    
    const at = before.lastIndexOf('@');
    const hash = before.lastIndexOf('#');
    
    let index = -1;
    let trigger = '';
    
    if (at > hash) {
        index = at;
        trigger = '@';
    } else {
        index = hash;
        trigger = '#';
    }
    
    if (index === -1) return null;
    if (index > 0) {
        const prev = before.charAt(index - 1);
        if (!/\s/.test(prev)) return null;
    }
    
    const query = before.slice(index + 1);
    if (/\s/.test(query)) return null;
    
    mentionTrigger = trigger;
    return query;
}
function filterMention() {
    const q = mentionQuery.toLowerCase();
    let sourceItems = [];
    
    if (mentionTrigger === '@') {
        sourceItems = (allContacts || []).map(c => ({
            type: 'contact',
            label: c.username,
            value: c.username,
            detail: c.ip
        }));
    } else if (mentionTrigger === '#') {
        sourceItems = directoryItems;
    }
    
    mentionItems = sourceItems.filter(it => !q || it.label.toLowerCase().includes(q));
    if (mentionItems.length > 0 && mentionIndex === -1) mentionIndex = 0;
    if (mentionIndex >= mentionItems.length) mentionIndex = 0;
    renderMention();
}
function renderMention() {
    if (!mentionActive || mentionItems.length === 0) {
        $mentionSuggest.hide().empty();
        return;
    }
    $mentionSuggest.show().empty();
    
    mentionItems.slice(0, 50).forEach((it, idx) => {
        const $div = $('<div>').addClass('mention-item' + (idx === mentionIndex ? ' active' : ''));
        const iconClass = it.type === 'contact' ? 'codicon-account' : it.type === 'folder' ? 'codicon-folder' : it.type === 'image' ? 'codicon-file-media' : 'codicon-file';
        const $icon = $('<span>').addClass('codicon ' + iconClass);
        const $label = $('<span>').text(it.label);
        $div.append($icon).append($label);
        
        if (mentionTrigger === '#' && it.type === 'folder') {
            const $arrow = $('<span>').addClass('codicon codicon-chevron-right').css({ marginLeft: 'auto', fontSize: '12px' });
            $div.append($arrow);
        }
        
        if (it.detail) {
            const $t = $('<span>').addClass('type').text(it.detail);
            $div.append($t);
        } 
        
        $div.on('mouseenter', () => {
            mentionIndex = idx;
            renderMention();
        }).on('mousedown', (e) => {
            e.preventDefault();
        }).on('click', () => {
            applyMention(mentionItems[idx]);
            closeMention();
        });
        $mentionSuggest.append($div);
    });
}
function applyMention(item) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    let range = sel.getRangeAt(0);
    let container = range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE) {
        const placeholder = document.createTextNode('');
        range.insertNode(placeholder);
        range.setStart(placeholder, 0);
        range.setEnd(placeholder, 0);
        container = placeholder;
    }
    const textNode = container;
    const beforeText = textNode.data.slice(0, range.startOffset);
    const afterText = textNode.data.slice(range.startOffset);
    
    const atIndex = beforeText.lastIndexOf('@');
    const hashIndex = beforeText.lastIndexOf('#');
    const index = Math.max(atIndex, hashIndex);
    
    if (index === -1) return;
    
    const head = beforeText.slice(0, index);
    textNode.data = head;
    
    const tag = createMentionTag(item, { closable: true, source: 'input' });
    
    const space = document.createTextNode(' ');
    const tail = document.createTextNode(afterText);
    
    if (textNode.nextSibling) {
        textNode.parentNode.insertBefore(tag[0], textNode.nextSibling);
    } else {
        textNode.parentNode.appendChild(tag[0]);
    }
    // Insert space after tag
    tag[0].parentNode.insertBefore(space, tag[0].nextSibling);
    // Insert tail after space
    space.parentNode.insertBefore(tail, space.nextSibling);
    
    const newRange = document.createRange();
    newRange.setStart(tail, 0);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    $input.focus();
}

function createMentionTag(item, opts) {
    const trigger = item.type === 'contact' ? '@' : '#';
    const iconClass = item.type === 'contact' ? 'codicon-account' : item.type === 'folder' ? 'codicon-folder' : item.type === 'image' ? 'codicon-file-media' : 'codicon-file';
    
    const $span = $('<span>')
        .addClass('mention-tag')
        .attr('data-type', item.type)
        .attr('data-value', item.value)
        .attr('data-trigger', trigger);
    
    if (opts && opts.source === 'input') {
        $span.attr('contenteditable', 'false');
    }
    
    const $icon = $('<span>').addClass('codicon ' + iconClass);
    const $label = $('<span>').addClass('label').text((item.type === 'contact' ? '@' : '') + item.label);
    
    $span.append($icon).append($label);
    
    if (opts && opts.closable) {
        const $close = $('<span>')
            .addClass('close codicon codicon-close')
            .attr('title', '移除')
            .on('click', (e) => {
                e.stopPropagation();
                $span.remove();
            });
        $span.append($close);
    }
    
    $span.on('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
            type: 'tagClicked',
            item: { type: item.type, value: item.value, label: item.label }
        });
        if (opts && opts.source === 'input') {
            $input.focus();
        }
    });
    return $span;
}
function resolveMentionItem(val, trigger) {
    // trigger hint helps disambiguate if needed
    if (!trigger || trigger === '@') {
        const c = (allContacts || []).find(x => x.username === val);
        if (c) return { type: 'contact', value: c.username, label: c.username, detail: c.ip };
    }
    if (!trigger || trigger === '#') {
        // val could be full path or basename?
        // In renderMessageContent we extract name. 
        // If the message raw text is #path/to/file.ts, then name is path/to/file.ts
        // If it is #file.ts, name is file.ts
        // Let's check filesCache for suffix match or full match
        const fldr = (foldersCache || []).find(x => x === val || x.endsWith('/' + val));
        if (fldr) return { type: 'folder', value: fldr, label: fldr.split('/').pop() };
        const file = (filesCache || []).find(x => x === val || x.endsWith('/' + val));
        if (file) return { type: 'file', value: file, label: file.split('/').pop() };
        
        // Fallback guessing for when cache is empty (recursive browse mode)
        // Check if looks like image
        if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(val)) {
            return { type: 'image', value: val, label: val.split(/[\/\\]/).pop() };
        }
        if (val.includes('/') || val.includes('\\')) {
             const isFile = /\.[^/\\]+$/.test(val);
             return { type: isFile ? 'file' : 'folder', value: val, label: val.split(/[\/\\]/).pop() };
        }
        if (/\.[^/\\]+$/.test(val)) {
             return { type: 'file', value: val, label: val };
        }
    }
    // Fallback
    return { type: 'mention', value: val, label: val };
}
function buildMessageText() {
    let s = '';
    $input[0].childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            s += node.nodeValue;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const $el = $(node);
            if ($el.hasClass('mention-tag')) {
                const v = $el.data('value') || '';
                const trigger = $el.data('trigger') || '@';
                s += trigger + v + ' ';
            } else {
                s += $el.text();
            }
        }
    });
    return s;
}
function getCaretCharacterOffsetWithin(element) {
    let caretOffset = 0;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(element);
    preRange.setEnd(range.endContainer, range.endOffset);
    caretOffset = preRange.toString().length;
    return caretOffset;
}
function placeCaretAtEnd(el) {
    $(el).focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}
function renderContacts() {
    $contactsTbody.empty();
    contacts.forEach((c) => {
        const portText = c.port && c.port > 0 && c.port <= 65535 ? String(c.port) : '';
        const hostText = c.ip ? (portText ? (c.ip + ':' + portText) : c.ip) : '';
        
        const $tr = $('<tr>');
        const $tdHost = $('<td>').text(hostText);
        
        // Username + Status Dot
        const $tdUser = $('<td>');
        const $nameSpan = $('<span>').text(c.username);
        $tdUser.append($nameSpan);

        const key = (c.ip || '') + '|' + String(c.port || '') + '|' + (c.username || '');
        const status = contactStatusMap[key];
        
        if (status === 'online' || status === 'offline') {
            const $dot = $('<span>')
                .addClass('status-dot ' + status)
                .attr('title', status === 'online' ? '在线' : '离线');
            $tdUser.append($dot);
        }

        const $tdOps = $('<td>');
        const $checkBtn = $('<button>')
            .addClass('text-btn')
            .text('检测')
            .on('click', () => {
                vscode.postMessage({ type: 'checkContactLink', contact: c });
            });
        const $delBtn = $('<button>')
            .addClass('text-btn')
            .text('删除')
            .on('click', () => {
                vscode.postMessage({ type: 'deleteContact', contact: c });
            });
        $tdOps.append($checkBtn).append($delBtn);
        
        $tr.append($tdHost).append($tdUser).append($tdOps);
        $contactsTbody.append($tr);
    });
    if ($contactsOverlay.css('display') === 'flex' && !contactsStatusRequested && contacts.length > 0) {
        contactsStatusRequested = true;
        requestContactsOnlineStatus(contacts);
    }
}
function updateIpSelectOptions() {
    if ($ipInput.length === 0) {
        return;
    }
    const current = (currentUserSettings && currentUserSettings.ip) || $ipInput.val() || '';
    $ipInput.empty();
    const placeholderText = localIps.length ? '请选择本机 IP 地址' : '无可用 IP 地址';
    $ipInput.append($('<option>').val('').text(placeholderText));
    
    localIps.forEach((addr) => {
        $ipInput.append($('<option>').val(addr).text(addr));
    });
    
    if (current) {
        let found = false;
        $ipInput.find('option').each(function() {
            if ($(this).val() === current) {
                found = true;
                return false;
            }
        });
        if (!found) {
            $ipInput.append($('<option>').val(current).text(current));
        }
        $ipInput.val(current);
    } else {
        $ipInput.val('');
    }
}
function requestContactsOnlineStatus(list) {
    const payload = list.map(c => ({
        ip: c.ip,
        port: c.port,
        username: c.username
    }));
    vscode.postMessage({ type: 'getContactsStatus', contacts: payload });
}

// --- Initialization ---

// Request initial settings
vscode.postMessage({ type: 'getSettings' });
vscode.postMessage({ type: 'getLocalIps' });

