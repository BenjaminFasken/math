document.addEventListener('DOMContentLoaded', () => { // codex resume 019d5c83-6839-7680-8d6f-6bee9c0e283c
    const container = document.getElementById('editor-container');
    const toggleThemeBtn = document.getElementById('toggle-theme');
    const addTextBtn = document.getElementById('add-text');
    const addMathBtn = document.getElementById('add-math');
    const saveBtn = document.getElementById('btn-save');
    const loadBtn = document.getElementById('btn-load');
    const fileInput = document.getElementById('file-input');

    const selectionLayer = document.createElement('div');
    selectionLayer.className = 'document-selection-layer';
    const HISTORY_STORAGE_KEY = 'docHistory';
    const HISTORY_STORAGE_VERSION = 1;
    const HISTORY_PERSIST_DELAY_MS = 250;
    // Leave headroom for other localStorage keys such as docState/theme.
    const MAX_HISTORY_STORAGE_BYTES = Math.floor(4.5 * 1024 * 1024);

    let lastSelectedBlock = null;
    let dragState = null;
    let crossBlockSelection = null;
    let suppressDocumentClickClear = false;
    let historyStack = [];
    let historyIndex = -1;
    let isRestoringHistory = false;
    let historyPersistTimer = null;

    function ensureSelectionLayer() {
        if (!selectionLayer.isConnected) {
            container.appendChild(selectionLayer);
        }
    }

    function getBlocks() {
        return Array.from(container.querySelectorAll('.block'));
    }

    function getFirstBlock() {
        return getBlocks()[0] ?? null;
    }

    function getLastBlock() {
        const blocks = getBlocks();
        return blocks[blocks.length - 1] ?? null;
    }

    function getPreviousBlock(block) {
        let previous = block.previousElementSibling;
        while (previous && !previous.classList.contains('block')) {
            previous = previous.previousElementSibling;
        }
        return previous;
    }

    function getNextBlock(block) {
        let next = block.nextElementSibling;
        while (next && !next.classList.contains('block')) {
            next = next.nextElementSibling;
        }
        return next;
    }

    function isMathBlock(block) {
        return block?.tagName?.toLowerCase() === 'math-field';
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function clearSelection(except = null) {
        getBlocks().forEach((block) => {
            if (block !== except) {
                block.classList.remove('selected');
                block.classList.remove('cross-selected');
            }
        });
    }

    function clearCrossBlockSelection() {
        crossBlockSelection = null;
        selectionLayer.innerHTML = '';
        container.classList.remove('cross-selecting');
    }

    function suppressNativeSelection() {
        window.getSelection()?.removeAllRanges();

        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && activeElement !== document.body) {
            activeElement.blur();
        }
    }

    function getSelectedBlocks() {
        return Array.from(container.querySelectorAll('.selected'));
    }

    function getTextBlockFromEvent(event) {
        const eventTarget = event.target instanceof Element ? event.target.closest('.text-line') : null;
        if (eventTarget) return eventTarget;

        const activeTarget = document.activeElement instanceof Element
            ? document.activeElement.closest('.text-line')
            : null;
        if (activeTarget) return activeTarget;

        const selectionNode = window.getSelection()?.anchorNode;
        const selectionTarget = selectionNode instanceof Element
            ? selectionNode.closest('.text-line')
            : selectionNode?.parentElement?.closest('.text-line');
        if (selectionTarget) return selectionTarget;

        const selectedTextBlock = getSelectedBlocks().find((block) => block.classList.contains('text-line'));
        if (selectedTextBlock) return selectedTextBlock;

        return lastSelectedBlock?.classList?.contains('text-line') ? lastSelectedBlock : null;
    }

    function getBlockFromEvent(event) {
        const eventTarget = event.target instanceof Element ? event.target.closest('.block') : null;
        if (eventTarget) return eventTarget;

        const activeTarget = document.activeElement instanceof Element
            ? document.activeElement.closest('.block')
            : null;
        if (activeTarget) return activeTarget;

        const selectionNode = window.getSelection()?.anchorNode;
        const selectionTarget = selectionNode instanceof Element
            ? selectionNode.closest('.block')
            : selectionNode?.parentElement?.closest('.block');
        if (selectionTarget) return selectionTarget;

        const selectedBlock = getSelectedBlocks()[0];
        if (selectedBlock) return selectedBlock;

        return lastSelectedBlock?.classList?.contains('block') ? lastSelectedBlock : null;
    }

    function getCurrentBlock() {
        const activeTarget = document.activeElement instanceof Element
            ? document.activeElement.closest('.block')
            : null;
        if (activeTarget) return activeTarget;

        const selectionNode = window.getSelection()?.anchorNode;
        const selectionTarget = selectionNode instanceof Element
            ? selectionNode.closest('.block')
            : selectionNode?.parentElement?.closest('.block');
        if (selectionTarget) return selectionTarget;

        const selectedBlock = getSelectedBlocks()[0];
        if (selectedBlock) return selectedBlock;

        return lastSelectedBlock?.classList?.contains('block') ? lastSelectedBlock : null;
    }

    function blocksToString(blocks) {
        let content = [];
        for (const el of blocks) {
            if (isMathBlock(el)) {
                content.push(`$$ ${el.value} $$`);
            } else if (el.classList.contains('text-line')) {
                content.push(el.innerText.trim());
            }
        }
        return content.join('\n\n');
    }

    function splitPastedTextIntoBlocks(text) {
        return text
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .filter((line) => line.trim() !== '');
    }

    function extractMathPasteValue(text) {
        const trimmed = text.trim();
        if (trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
            return trimmed.slice(2, -2).trim();
        }
        return trimmed;
    }

    function shouldPasteAsMath(text, sourceBlock = null) {
        const trimmed = text.trim();
        return isMathBlock(sourceBlock)
            || (trimmed.startsWith('$$') && trimmed.endsWith('$$'));
    }

    function appendBlockFromText(text, refNode = null, sourceBlock = null) {
        if (shouldPasteAsMath(text, sourceBlock)) {
            return appendMathBlock(extractMathPasteValue(text), refNode);
        }
        return appendTextBlock(text, refNode);
    }

    function getTextBlockValue(block) {
        return block.textContent ?? '';
    }

    function ensureTextBlockPlaceholder(block) {
        if (getTextBlockValue(block) === '' && block.innerHTML === '') {
            block.innerHTML = '<br>';
        }
    }

    function setTextBlockValue(block, text) {
        if (text === '') {
            block.innerHTML = '<br>';
        } else {
            block.textContent = text;
        }
    }

    function getTextLength(block) {
        return getTextBlockValue(block).length;
    }

    function getTextOffsetFromDomPosition(block, node, offset) {
        const range = document.createRange();
        range.selectNodeContents(block);
        try {
            range.setEnd(node, offset);
        } catch {
            return getTextLength(block);
        }
        return range.toString().length;
    }

    function getTextPositionFromOffset(block, targetOffset) {
        const textLength = getTextLength(block);
        if (textLength === 0) {
            ensureTextBlockPlaceholder(block);
            return { node: block, offset: 0 };
        }

        let remaining = clamp(targetOffset, 0, textLength);
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        let lastTextNode = null;

        while (node) {
            lastTextNode = node;
            const length = node.textContent.length;
            if (remaining <= length) {
                return { node, offset: remaining };
            }
            remaining -= length;
            node = walker.nextNode();
        }

        if (lastTextNode) {
            return { node: lastTextNode, offset: lastTextNode.textContent.length };
        }

        return { node: block, offset: block.childNodes.length };
    }

    function getTextOffsetFromPoint(block, clientX, clientY) {
        if (document.caretPositionFromPoint) {
            const position = document.caretPositionFromPoint(clientX, clientY);
            if (position && block.contains(position.offsetNode)) {
                return clamp(
                    getTextOffsetFromDomPosition(block, position.offsetNode, position.offset),
                    0,
                    getTextLength(block)
                );
            }
        }

        if (document.caretRangeFromPoint) {
            const range = document.caretRangeFromPoint(clientX, clientY);
            if (range && block.contains(range.startContainer)) {
                return clamp(
                    getTextOffsetFromDomPosition(block, range.startContainer, range.startOffset),
                    0,
                    getTextLength(block)
                );
            }
        }

        const rect = block.getBoundingClientRect();
        return clientX <= rect.left + rect.width / 2 ? 0 : getTextLength(block);
    }

    function setTextCaret(block, offset) {
        const range = document.createRange();
        const selection = window.getSelection();

        if (getTextLength(block) === 0) {
            ensureTextBlockPlaceholder(block);
            range.selectNodeContents(block);
            range.collapse(true);
        } else {
            const position = getTextPositionFromOffset(block, offset);
            range.setStart(position.node, position.offset);
            range.collapse(true);
        }

        selection.removeAllRanges();
        selection.addRange(range);
    }

    function getBlockLength(block) {
        return isMathBlock(block) ? block.lastOffset : getTextLength(block);
    }

    function mergeSelectionRects(clientRects, containerRect) {
        const rects = clientRects
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .map((rect) => ({
                left: rect.left - containerRect.left,
                top: rect.top - containerRect.top,
                width: rect.width,
                height: rect.height,
            }))
            .sort((a, b) => (a.top - b.top) || (a.left - b.left));

        const merged = [];

        for (const rect of rects) {
            const previous = merged[merged.length - 1];
            const isSameLine = previous
                && Math.abs(previous.top - rect.top) < 6
                && Math.abs(previous.height - rect.height) < 10;

            if (isSameLine && rect.left <= previous.left + previous.width + 8) {
                const left = Math.min(previous.left, rect.left);
                const right = Math.max(previous.left + previous.width, rect.left + rect.width);
                previous.left = left;
                previous.width = right - left;
                previous.top = Math.min(previous.top, rect.top);
                previous.height = Math.max(previous.height, rect.height);
            } else {
                merged.push(rect);
            }
        }

        return merged;
    }

    function getTextSelectionRects(block, start, end, containerRect) {
        if (start === end) return [];

        const range = document.createRange();
        const startPosition = getTextPositionFromOffset(block, start);
        const endPosition = getTextPositionFromOffset(block, end);

        try {
            range.setStart(startPosition.node, startPosition.offset);
            range.setEnd(endPosition.node, endPosition.offset);
        } catch {
            return [];
        }

        return mergeSelectionRects(Array.from(range.getClientRects()), containerRect);
    }

    function getMathSelectionRects(block, start, end, containerRect) {
        const min = clamp(Math.min(start, end), 0, block.lastOffset);
        const max = clamp(Math.max(start, end), 0, block.lastOffset);
        if (min === max) return [];

        const rects = [];
        for (let offset = min + 1; offset <= max; offset += 1) {
            const bounds = block.getElementInfo(offset)?.bounds;
            if (bounds && bounds.width > 0 && bounds.height > 0) {
                rects.push(bounds);
            }
        }

        if (rects.length === 0) {
            const blockRect = block.getBoundingClientRect();
            rects.push(new DOMRect(
                blockRect.left + 8,
                blockRect.top + 8,
                Math.max(0, blockRect.width - 16),
                Math.max(0, blockRect.height - 16)
            ));
        }

        return mergeSelectionRects(rects, containerRect);
    }

    function appendSelectionRect(rect) {
        const node = document.createElement('div');
        node.className = 'selection-rect';
        node.style.left = `${rect.left}px`;
        node.style.top = `${rect.top}px`;
        node.style.width = `${rect.width}px`;
        node.style.height = `${rect.height}px`;
        selectionLayer.appendChild(node);
    }

    function findClosestBlockByY(clientY) {
        const blocks = getBlocks();
        if (blocks.length === 0) return null;

        let bestBlock = blocks[0];
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const block of blocks) {
            const rect = block.getBoundingClientRect();
            if (clientY >= rect.top && clientY <= rect.bottom) {
                return block;
            }

            const distance = Math.min(Math.abs(clientY - rect.top), Math.abs(clientY - rect.bottom));
            if (distance < bestDistance) {
                bestDistance = distance;
                bestBlock = block;
            }
        }

        return bestBlock;
    }

    function getBlockAtPoint(clientX, clientY) {
        const hovered = document.elementFromPoint(clientX, clientY);
        return hovered?.closest('.block') ?? findClosestBlockByY(clientY);
    }

    function getPointFromClientCoordinates(clientX, clientY) {
        const block = getBlockAtPoint(clientX, clientY);
        if (!block) return null;

        const blocks = getBlocks();
        const index = blocks.indexOf(block);
        if (index === -1) return null;

        const offset = isMathBlock(block)
            ? clamp(block.getOffsetFromPoint(clientX, clientY), 0, block.lastOffset)
            : getTextOffsetFromPoint(block, clientX, clientY);

        return { block, index, offset };
    }

    function compareSelectionPoints(a, b) {
        if (a.index !== b.index) return a.index - b.index;
        return a.offset - b.offset;
    }

    function getNormalizedCrossBlockSelection() {
        if (!crossBlockSelection?.anchor || !crossBlockSelection?.focus) return null;

        const blocks = getBlocks();
        const anchor = {
            ...crossBlockSelection.anchor,
            index: blocks.indexOf(crossBlockSelection.anchor.block),
        };
        const focus = {
            ...crossBlockSelection.focus,
            index: blocks.indexOf(crossBlockSelection.focus.block),
        };

        if (anchor.index === -1 || focus.index === -1) return null;
        return compareSelectionPoints(anchor, focus) <= 0
            ? { start: anchor, end: focus }
            : { start: focus, end: anchor };
    }

    function hasExpandedCrossBlockSelection() {
        const selection = getNormalizedCrossBlockSelection();
        return !!selection
            && (selection.start.index !== selection.end.index || selection.start.offset !== selection.end.offset);
    }

    function renderCrossBlockSelection() {
        ensureSelectionLayer();
        selectionLayer.innerHTML = '';
        clearSelection();

        if (!hasExpandedCrossBlockSelection()) {
            container.classList.remove('cross-selecting');
            return;
        }

        container.classList.add('cross-selecting');

        const blocks = getBlocks();
        const containerRect = container.getBoundingClientRect();
        const selection = getNormalizedCrossBlockSelection();

        for (let index = selection.start.index; index <= selection.end.index; index += 1) {
            const block = blocks[index];
            const start = index === selection.start.index ? selection.start.offset : 0;
            const end = index === selection.end.index ? selection.end.offset : getBlockLength(block);
            const rects = isMathBlock(block)
                ? getMathSelectionRects(block, start, end, containerRect)
                : getTextSelectionRects(block, start, end, containerRect);

            block.classList.add('selected', 'cross-selected');
            rects.forEach(appendSelectionRect);
        }
    }

    function getCrossBlockSelectionText() {
        const selection = getNormalizedCrossBlockSelection();
        if (!selection || !hasExpandedCrossBlockSelection()) return '';

        const blocks = getBlocks();
        const content = [];

        for (let index = selection.start.index; index <= selection.end.index; index += 1) {
            const block = blocks[index];
            const start = index === selection.start.index ? selection.start.offset : 0;
            const end = index === selection.end.index ? selection.end.offset : getBlockLength(block);

            if (isMathBlock(block)) {
                content.push(block.getValue(start, end, 'latex'));
            } else {
                content.push(getTextBlockValue(block).slice(start, end));
            }
        }

        return content.join('\n');
    }

    function placeCaretInBlock(block, offset) {
        clearCrossBlockSelection();
        clearSelection();

        block.classList.add('selected');
        lastSelectedBlock = block;
        block.focus();

        if (isMathBlock(block)) {
            block.position = clamp(offset, 0, block.lastOffset);
        } else {
            setTextCaret(block, clamp(offset, 0, getTextLength(block)));
        }
    }

    function insertBlockBelow(block, isMath) {
        const refNode = getNextBlock(block) ?? selectionLayer;
        const newBlock = isMath ? appendMathBlock(null, refNode) : appendTextBlock(null, refNode);
        placeCaretInBlock(newBlock, 0);
        saveState();
        return newBlock;
    }

    function deleteCrossBlockSelection() {
        const selection = getNormalizedCrossBlockSelection();
        if (!selection || !hasExpandedCrossBlockSelection()) return null;

        const blocks = getBlocks();
        const startBlock = blocks[selection.start.index];

        for (let index = selection.end.index; index >= selection.start.index; index -= 1) {
            const block = blocks[index];
            const start = index === selection.start.index ? selection.start.offset : 0;
            const end = index === selection.end.index ? selection.end.offset : getBlockLength(block);

            if (start === end) continue;

            if (isMathBlock(block)) {
                block.selection = { ranges: [[start, end]], direction: 'forward' };
                block.executeCommand('delete-backward');
            } else {
                const text = getTextBlockValue(block);
                setTextBlockValue(block, text.slice(0, start) + text.slice(end));
            }
        }

        let remainingBlocks = getBlocks();
        for (const block of [...remainingBlocks]) {
            if (getBlockLength(block) === 0 && remainingBlocks.length > 1) {
                block.remove();
                remainingBlocks = getBlocks();
            }
        }

        if (remainingBlocks.length === 0) {
            const freshBlock = appendMathBlock();
            placeCaretInBlock(freshBlock, 0);
            saveState();
            return freshBlock;
        }

        const focusBlock = startBlock?.isConnected
            ? startBlock
            : remainingBlocks[Math.min(selection.start.index, remainingBlocks.length - 1)];
        const focusOffset = startBlock?.isConnected ? selection.start.offset : 0;

        placeCaretInBlock(focusBlock, focusOffset);
        saveState();
        return focusBlock;
    }

    function finishPointerSelection() {
        dragState = null;
        if (!hasExpandedCrossBlockSelection()) {
            clearCrossBlockSelection();
        }
    }

    ensureSelectionLayer();

    // Use capture phase so MathLive and contenteditable blocks cannot hide cross-block drags.
    document.addEventListener('pointerdown', (e) => {
        if (e.isPrimary === false || e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target.closest('.toolbar')) return;

        const point = getPointFromClientCoordinates(e.clientX, e.clientY);
        if (!point) return;

        dragState = {
            pointerId: e.pointerId,
            anchor: point,
            focus: point,
            isCrossBlock: false,
        };

        if (!e.shiftKey) {
            clearCrossBlockSelection();
        }
    }, { capture: true });

    document.addEventListener('pointermove', (e) => {
        if (!dragState || dragState.pointerId !== e.pointerId) return;
        if (e.buttons !== 1 && e.pointerType === 'mouse') {
            finishPointerSelection();
            return;
        }

        const point = getPointFromClientCoordinates(e.clientX, e.clientY);
        if (!point) return;

        dragState.focus = point;
        if (!dragState.isCrossBlock && point.index !== dragState.anchor.index) {
            dragState.isCrossBlock = true;
            suppressNativeSelection();
        }

        if (!dragState.isCrossBlock) return;

        suppressDocumentClickClear = true;
        suppressNativeSelection();
        crossBlockSelection = { anchor: dragState.anchor, focus: point };
        renderCrossBlockSelection();
    }, { capture: true });

    document.addEventListener('pointerup', finishPointerSelection, { capture: true });
    document.addEventListener('pointercancel', finishPointerSelection, { capture: true });
    document.addEventListener('selectstart', (e) => {
        if (!dragState?.isCrossBlock && !hasExpandedCrossBlockSelection()) return;
        e.preventDefault();
    }, { capture: true });

    document.addEventListener('click', (e) => {
        if (suppressDocumentClickClear) {
            suppressDocumentClickClear = false;
            return;
        }

        if (!e.target.closest('.block') && !e.target.closest('.toolbar')) {
            clearCrossBlockSelection();
            clearSelection();
        }
    });

    function handleTextLineBeforeInput(e) {
        const target = getTextBlockFromEvent(e);
        if (!target || hasExpandedCrossBlockSelection()) return;
        if (e.inputType === 'insertParagraph') {
            e.preventDefault();
            e.stopImmediatePropagation();
            insertBlockBelow(target, false);
        }
    }

    function handleTextLineEnterKey(e) {
        const target = getTextBlockFromEvent(e);
        if (!target || hasExpandedCrossBlockSelection()) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            e.stopImmediatePropagation();
            insertBlockBelow(target, false);
        }
    }

    function handleUndoRedoShortcuts(e) {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
        if (e.key.toLowerCase() !== 'z') return;

        e.preventDefault();
        e.stopImmediatePropagation();

        if (e.shiftKey) {
            redoHistory();
        } else {
            undoHistory();
        }
    }

    window.addEventListener('beforeinput', handleTextLineBeforeInput, true);
    document.addEventListener('beforeinput', handleTextLineBeforeInput, true);

    window.addEventListener('keydown', handleUndoRedoShortcuts, true);
    window.addEventListener('keydown', handleTextLineEnterKey, true);
    document.addEventListener('keydown', handleTextLineEnterKey, true);
    window.addEventListener('beforeunload', persistHistoryNow);
    window.addEventListener('pagehide', persistHistoryNow);

    window.addEventListener('resize', () => {
        if (hasExpandedCrossBlockSelection()) {
            renderCrossBlockSelection();
        }
    });

    document.addEventListener('scroll', () => {
        if (hasExpandedCrossBlockSelection()) {
            renderCrossBlockSelection();
        }
    }, true);

    document.addEventListener('keydown', (e) => {
        if (hasExpandedCrossBlockSelection()) {
            if (e.key === 'Backspace' || e.key === 'Delete') {
                e.preventDefault();
                deleteCrossBlockSelection();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'x')) {
                e.preventDefault();
                navigator.clipboard.writeText(getCrossBlockSelectionText());
                if (e.key === 'x') {
                    deleteCrossBlockSelection();
                }
                return;
            }

            if (e.key === 'Escape') {
                clearCrossBlockSelection();
                clearSelection();
            }
            return;
        }

        const selected = getSelectedBlocks();
        if (selected.length > 1) {
            if ((e.key === 'Backspace' || e.key === 'Delete')) {
                e.preventDefault();
                deleteSelected();
            } else if (e.ctrlKey || e.metaKey) {
                if (e.key === 'c' || e.key === 'x') {
                    e.preventDefault();
                    navigator.clipboard.writeText(blocksToString(selected));
                    if (e.key === 'x') {
                        deleteSelected();
                    }
                }
            }
        } else if (selected.length === 1 && (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'x') && document.activeElement === document.body) {
             // In case block is selected but not focused in a way that allows native copy
             // Actually native copy covers it if single block is focused. But we can override to ensure format.
             // We'll let native copy run for now.
        }
    });
    
    function handleMultiBlockPaste(e, sourceBlock = null) {
        if (e.__multiBlockPasteHandled) return;

        const text = (e.clipboardData || window.clipboardData)?.getData('text') ?? '';
        const selected = getSelectedBlocks();
        const chunks = splitPastedTextIntoBlocks(text);
        const hasCrossSelection = hasExpandedCrossBlockSelection();

        if (!hasCrossSelection && selected.length <= 1 && chunks.length <= 1) {
            return;
        }

        e.__multiBlockPasteHandled = true;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        let target = sourceBlock ?? getBlockFromEvent(e);

        if (hasCrossSelection) {
            target = deleteCrossBlockSelection() ?? target;
        } else if (selected.length > 0) {
            target = selected[selected.length - 1];
        } else if (!target || !target.classList.contains('block')) {
            target = getBlockFromEvent(e) ?? getLastBlock();
        }

        if (!target) {
            target = appendMathBlock();
        }

        let currentRef = target;
        const remainingChunks = [...chunks];

        if (!hasCrossSelection && selected.length <= 1 && getBlockLength(target) === 0 && remainingChunks.length > 0) {
            const firstChunk = remainingChunks.shift();
            if (isMathBlock(target)) {
                target.value = extractMathPasteValue(firstChunk);
            } else {
                setTextBlockValue(target, firstChunk);
            }
        }

        remainingChunks.forEach((chunk) => {
            const newEl = appendBlockFromText(chunk, currentRef ? currentRef.nextSibling : null, target);
            if (newEl) currentRef = newEl;
        });

        if (!hasCrossSelection && selected.length > 1) {
             selected.forEach((block) => block.remove());
        }

        if (currentRef) {
            placeCaretInBlock(currentRef, 0);
        }
        saveState();
    }

    // Handle paste for multiple blocks before MathLive/contenteditable consume it.
    window.addEventListener('paste', (e) => {
        handleMultiBlockPaste(e);
    }, true);

    document.addEventListener('paste', (e) => {
        handleMultiBlockPaste(e);
    }, true);

    function deleteSelected() {
        const selected = getSelectedBlocks();
        if (selected.length === 0) return;
        const firstSelected = selected[0];
        let prev = getPreviousBlock(firstSelected);
        
        selected.forEach(b => b.remove());
        
        if (prev && prev.classList.contains('block')) {
            prev.focus();
            prev.classList.add('selected');
        } else if (getFirstBlock()) {
            getFirstBlock().focus();
            getFirstBlock().classList.add('selected');
        } else {
            appendMathBlock().focus();
        }
        saveState();
    }

    function getHistorySnapshotKey(blocks) {
        return JSON.stringify(blocks);
    }

    function getStorageByteLength(value) {
        return new TextEncoder().encode(value).length;
    }

    function getSerializedHistoryEntry(snapshot) {
        return {
            b: snapshot.blocks.map((block) => [block.type === 'math' ? 1 : 0, block.value]),
            f: [
                snapshot.focus?.index ?? 0,
                snapshot.focus?.offset ?? 0,
                snapshot.focus?.isMath ? 1 : 0,
            ],
        };
    }

    function getHistoryStoragePayload(entries = historyStack, index = historyIndex) {
        return JSON.stringify({
            version: HISTORY_STORAGE_VERSION,
            index: clamp(index, 0, Math.max(0, entries.length - 1)),
            entries: entries.map(getSerializedHistoryEntry),
        });
    }

    function getTrimmedHistoryStorage(entries = historyStack, index = historyIndex) {
        if (entries.length === 0) {
            return { entries: [], index: -1, payload: '' };
        }

        let trimmedEntries = entries.slice();
        let trimmedIndex = clamp(index, 0, Math.max(0, trimmedEntries.length - 1));
        let payload = getHistoryStoragePayload(trimmedEntries, trimmedIndex);

        while (trimmedEntries.length > 1 && getStorageByteLength(payload) > MAX_HISTORY_STORAGE_BYTES) {
            trimmedEntries = trimmedEntries.slice(1);
            trimmedIndex = Math.max(0, trimmedIndex - 1);
            payload = getHistoryStoragePayload(trimmedEntries, trimmedIndex);
        }

        return {
            entries: trimmedEntries,
            index: trimmedIndex,
            payload,
        };
    }

    function persistHistoryNow() {
        if (historyPersistTimer !== null) {
            window.clearTimeout(historyPersistTimer);
            historyPersistTimer = null;
        }

        if (historyStack.length === 0) {
            localStorage.removeItem(HISTORY_STORAGE_KEY);
            return;
        }

        let trimmed = getTrimmedHistoryStorage();

        while (trimmed.entries.length > 0) {
            try {
                localStorage.setItem(HISTORY_STORAGE_KEY, trimmed.payload);
                return;
            } catch {
                if (trimmed.entries.length === 1) {
                    break;
                }

                trimmed = getTrimmedHistoryStorage(
                    trimmed.entries.slice(1),
                    Math.max(0, trimmed.index - 1)
                );
            }
        }

        localStorage.removeItem(HISTORY_STORAGE_KEY);
    }

    function scheduleHistoryPersistence() {
        if (historyPersistTimer !== null) {
            window.clearTimeout(historyPersistTimer);
        }

        historyPersistTimer = window.setTimeout(() => {
            historyPersistTimer = null;
            persistHistoryNow();
        }, HISTORY_PERSIST_DELAY_MS);
    }

    function parseStoredHistoryEntry(entry) {
        if (!entry || !Array.isArray(entry.b)) return null;

        const blocks = entry.b.map((block) => {
            if (!Array.isArray(block) || block.length < 2) return null;

            const [typeFlag, value] = block;
            if ((typeFlag !== 0 && typeFlag !== 1) || typeof value !== 'string') {
                return null;
            }

            return {
                type: typeFlag === 1 ? 'math' : 'text',
                value,
            };
        });

        if (blocks.some((block) => block === null)) {
            return null;
        }

        const focus = Array.isArray(entry.f) ? entry.f : [];
        return {
            blocks,
            key: getHistorySnapshotKey(blocks),
            focus: {
                index: Number.isFinite(Number(focus[0])) ? Number(focus[0]) : 0,
                offset: Number.isFinite(Number(focus[1])) ? Number(focus[1]) : 0,
                isMath: focus[2] === 1,
            },
        };
    }

    function loadHistoryFromStorage() {
        const storedHistory = localStorage.getItem(HISTORY_STORAGE_KEY);
        if (!storedHistory) return false;

        try {
            const payload = JSON.parse(storedHistory);
            if (payload?.version !== HISTORY_STORAGE_VERSION || !Array.isArray(payload.entries) || payload.entries.length === 0) {
                throw new Error('Invalid history payload');
            }

            const entries = payload.entries.map(parseStoredHistoryEntry);
            if (entries.some((entry) => entry === null)) {
                throw new Error('Invalid history entry');
            }

            historyStack = entries;
            historyIndex = clamp(Number(payload.index) || 0, 0, historyStack.length - 1);
            restoreHistorySnapshot(historyStack[historyIndex]);
            return true;
        } catch {
            localStorage.removeItem(HISTORY_STORAGE_KEY);
            return false;
        }
    }

    function getCurrentFocusSnapshot() {
        const block = getCurrentBlock();
        const blocks = getBlocks();
        const index = block ? blocks.indexOf(block) : -1;

        if (!block || index === -1) {
            return { index: 0, offset: 0, isMath: true };
        }

        if (isMathBlock(block)) {
            return {
                index,
                offset: clamp(block.position ?? block.lastOffset ?? 0, 0, block.lastOffset ?? 0),
                isMath: true,
            };
        }

        const selection = window.getSelection();
        let offset = getTextLength(block);
        if (selection?.anchorNode && block.contains(selection.anchorNode)) {
            offset = getTextOffsetFromDomPosition(block, selection.anchorNode, selection.anchorOffset);
        }

        return {
            index,
            offset: clamp(offset, 0, getTextLength(block)),
            isMath: false,
        };
    }

    function getHistoryBlocksSnapshot() {
        return getBlocks().map((block) => ({
            type: isMathBlock(block) ? 'math' : 'text',
            value: isMathBlock(block) ? block.value : getTextBlockValue(block),
        }));
    }

    function getHistorySnapshot() {
        const blocks = getHistoryBlocksSnapshot();
        return {
            blocks,
            key: getHistorySnapshotKey(blocks),
            focus: getCurrentFocusSnapshot(),
        };
    }

    function recordHistorySnapshot(force = false) {
        const snapshot = getHistorySnapshot();
        const current = historyStack[historyIndex];

        if (!force && current?.key === snapshot.key) {
            current.focus = snapshot.focus;
            scheduleHistoryPersistence();
            return;
        }

        historyStack = historyStack.slice(0, historyIndex + 1);
        historyStack.push(snapshot);
        historyIndex = historyStack.length - 1;
        scheduleHistoryPersistence();
    }

    function restoreHistorySnapshot(snapshot) {
        if (!snapshot) return;

        isRestoringHistory = true;
        clearCrossBlockSelection();
        clearSelection();
        lastSelectedBlock = null;
        container.innerHTML = '';
        ensureSelectionLayer();

        snapshot.blocks.forEach((block) => {
            if (block.type === 'math') {
                appendMathBlock(block.value);
            } else {
                appendTextBlock(block.value);
            }
        });

        if (getBlocks().length === 0) {
            appendMathBlock();
        }

        const blocks = getBlocks();
        const target = blocks[clamp(snapshot.focus?.index ?? 0, 0, Math.max(0, blocks.length - 1))];
        if (target) {
            placeCaretInBlock(target, snapshot.focus?.offset ?? 0);
        }

        localStorage.setItem('docState', getDocString());
        isRestoringHistory = false;
    }

    function undoHistory() {
        if (historyIndex <= 0) return;
        historyIndex -= 1;
        restoreHistorySnapshot(historyStack[historyIndex]);
        scheduleHistoryPersistence();
    }

    function redoHistory() {
        if (historyIndex >= historyStack.length - 1) return;
        historyIndex += 1;
        restoreHistorySnapshot(historyStack[historyIndex]);
        scheduleHistoryPersistence();
    }

    // Restore Theme
    if (localStorage.getItem('theme') === 'dark') {
        document.body.classList.add('dark-mode');
    }

    // Theme toggle
    toggleThemeBtn.addEventListener('click', () => {
        document.body.classList.toggle('dark-mode');
        localStorage.setItem('theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light');
    });

    function getDocString() {
        let content = [];
        for (const el of getBlocks()) {
            if (isMathBlock(el)) {
                if (el.value.trim() !== '') content.push(`$$ ${el.value} $$`);
            } else if (el.classList.contains('text-line')) {
                if (el.innerText.trim() !== '') content.push(el.innerText.trim());
            }
        }
        return content.join('\n\n');
    }

    function loadDocString(text) {
        clearCrossBlockSelection();
        clearSelection();
        lastSelectedBlock = null;
        container.innerHTML = '';
        ensureSelectionLayer();
        const chunks = text.split(/\n\s*\n/);
        chunks.forEach(chunk => {
            chunk = chunk.trim();
            if (!chunk) return;
            if (chunk.startsWith('$$') && chunk.endsWith('$$')) {
                const latex = chunk.slice(2, -2).trim();
                appendMathBlock(latex);
            } else {
                appendTextBlock(chunk);
            }
        });
        if (getBlocks().length === 0) {
            appendMathBlock();
        }
    }

    function stripLoadedFileComments(text) {
        return text
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((line) => {
                if (line.trimStart().startsWith('#')) {
                    return '';
                }

                const commentIndex = line.indexOf('#');
                if (commentIndex === -1) {
                    return line;
                }

                return line.slice(0, commentIndex).trimEnd();
            })
            .join('\n');
    }

    function saveState() {
        localStorage.setItem('docState', getDocString());
        if (!isRestoringHistory) {
            recordHistorySnapshot();
        }
    }

    // Auto save on input
    container.addEventListener('input', () => {
        if (hasExpandedCrossBlockSelection()) {
            clearCrossBlockSelection();
            clearSelection();
        }
        saveState();
    });

    // File Save/Load
    saveBtn.addEventListener('click', () => {
        const docString = getDocString();
        const blob = new Blob([docString], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'document.txt';
        a.click();
        URL.revokeObjectURL(url);
    });

    loadBtn.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            loadDocString(stripLoadedFileComments(ev.target.result));
            saveState();
        };
        reader.readAsText(file);
        
        fileInput.value = '';
    });

    function appendMathBlock(latex = null, refNode = null) {
        const mf = document.createElement('math-field');
        mf.classList.add('math-line', 'block');
        
        setupBlock(mf, true);
        ensureSelectionLayer();
        container.insertBefore(mf, refNode ?? selectionLayer);
        
        // Settings must happen after element is mounted
        mf.inlineShortcuts = null;
        mf.macros = {
            ...mf.macros,
            const: { args: 1, def: "\\boldsymbol{#1}" },
            eig: "\\text{eig}",
            eigv: "\\text{eigv}",
        };
        if (latex !== null) mf.value = latex;
        return mf;
    }

    function appendTextBlock(text = null, refNode = null) {
        const div = document.createElement('div');
        div.contentEditable = "true";
        div.classList.add('text-line', 'block');
        setupBlock(div, false);
        ensureSelectionLayer();
        container.insertBefore(div, refNode ?? selectionLayer);
        setTextBlockValue(div, text ?? '');
        return div;
    }

    addTextBtn.addEventListener('click', () => {
        clearCrossBlockSelection();
        clearSelection();
        const b = appendTextBlock();
        b.focus();
        saveState();
    });
    
    addMathBtn.addEventListener('click', () => {
        clearCrossBlockSelection();
        clearSelection();
        const b = appendMathBlock();
        b.focus();
        saveState();
    });


    function setupBlock(el, isMath) {
        el.addEventListener('mousedown', (e) => {
            if (e.shiftKey && lastSelectedBlock) {
                e.preventDefault();
                clearCrossBlockSelection();
                const blocks = getBlocks();
                const start = blocks.indexOf(lastSelectedBlock);
                const end = blocks.indexOf(el);
                const min = Math.min(start, end);
                const max = Math.max(start, end);
                clearSelection();
                for (let i = min; i <= max; i++) {
                    blocks[i].classList.add('selected');
                }
            } else {
                clearCrossBlockSelection();
                clearSelection();
                el.classList.add('selected');
                lastSelectedBlock = el;
            }
        }, true); // Use capture phase

        el.addEventListener('focus', () => {
            if (hasExpandedCrossBlockSelection()) {
                clearCrossBlockSelection();
            }
            if (!el.classList.contains('selected')) {
                clearSelection();
                el.classList.add('selected');
                lastSelectedBlock = el;
            }
        }, true); // Use capture phase

        el.addEventListener('paste', (e) => {
            handleMultiBlockPaste(e, el);
        }, true);

        if (isMath) {
            el.addEventListener('keydown', (e) => {
                if (hasExpandedCrossBlockSelection()) return;
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && el.mode === 'latex') {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    el.executeCommand('complete');
                    saveState();
                }
            }, true);
        }

        if (!isMath) {
            el.addEventListener('beforeinput', (e) => {
                if (hasExpandedCrossBlockSelection()) return;
                if (e.inputType === 'insertParagraph') {
                    e.preventDefault();
                    e.stopPropagation();
                    insertBlockBelow(el, false);
                }
            }, true);
        }

        el.addEventListener('keydown', (e) => {
            if (hasExpandedCrossBlockSelection()) return;
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                insertBlockBelow(el, isMath);
            } else if (e.key === 'Backspace') {
                const isEmpty = isMath ? el.value === '' : el.innerText.trim() === '';
                if (isEmpty && getBlocks().length > 1) {
                    const selected = getSelectedBlocks();
                    if (selected.length > 1) return; // handled by document event listener
                    e.preventDefault();
                    const prev = getPreviousBlock(el);
                    if (prev) {
                        prev.focus();
                        if (isMathBlock(prev)) {
                            prev.executeCommand('moveToMathfieldEnd');
                        } else {
                            const range = document.createRange();
                            const sel = window.getSelection();
                            range.selectNodeContents(prev);
                            range.collapse(false);
                            sel.removeAllRanges();
                            sel.addRange(range);
                        }
                    }
                    el.remove();
                    saveState();
                }
            } else if (e.key === 'ArrowUp') {
                const prev = getPreviousBlock(el);
                if (prev) {
                    if (e.shiftKey) {
                        e.preventDefault();
                        prev.classList.add('selected');
                    } else {
                        clearSelection();
                    }
                    prev.focus();
                }
            } else if (e.key === 'ArrowDown') {
                const next = getNextBlock(el);
                if (next) {
                    if (e.shiftKey) {
                        e.preventDefault();
                        next.classList.add('selected');
                    } else {
                        clearSelection();
                    }
                    next.focus();
                }
            }
        });
    }
    if (!loadHistoryFromStorage()) {
        const savedState = localStorage.getItem('docState');
        if (savedState) {
            loadDocString(savedState);
        } else {
            const initialField = appendMathBlock();
            initialField.focus();
        }
        recordHistorySnapshot(true);
    }
});
