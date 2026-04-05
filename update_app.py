import re

with open('js/app.js', 'r') as f:
    text = f.read()

# Add selection tracking
selection_logic = """
    let lastSelectedBlock = null;

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.block') && !e.target.closest('.toolbar')) {
            clearSelection();
        }
    });

    function clearSelection(except = null) {
        const blocks = Array.from(container.children);
        blocks.forEach(b => {
            if (b !== except) b.classList.remove('selected');
        });
    }

    function getSelectedBlocks() {
        return Array.from(container.querySelectorAll('.selected'));
    }

    function blocksToString(blocks) {
        let content = [];
        for (const el of blocks) {
            if (el.tagName.toLowerCase() === 'math-field') {
                content.push(`$$ ${el.value} $$`);
            } else if (el.classList.contains('text-line')) {
                content.push(el.innerText.trim());
            }
        }
        return content.join('\\n\\n');
    }

    document.addEventListener('keydown', (e) => {
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
    
    // We also need to handle Paste for multiple blocks.
    document.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        
        let target = document.activeElement;
        const selected = getSelectedBlocks();
        if (selected.length > 0) {
            target = selected[selected.length - 1];
        } else if (!target || !target.classList.contains('block')) {
            target = container.lastElementChild;
        }

        const chunks = text.split(/\\n\\s*\\n/);
        let currentRef = target;
        chunks.forEach(chunk => {
            chunk = chunk.trim();
            if (!chunk) return;
            let newEl;
            if (chunk.startsWith('$$') && chunk.endsWith('$$')) {
                const latex = chunk.slice(2, -2).trim();
                newEl = appendMathBlock(latex, currentRef ? currentRef.nextSibling : null);
            } else {
                newEl = appendTextBlock(chunk, currentRef ? currentRef.nextSibling : null);
            }
            currentRef = newEl;
        });
        
        // Remove original selected blocks if pasting over them (standard editor behavior)
        if (selected.length > 1) {
             selected.forEach(b => b.remove());
        }
        if (currentRef) currentRef.focus();
        saveState();
    });

    function deleteSelected() {
        const selected = getSelectedBlocks();
        if (selected.length === 0) return;
        const firstSelected = selected[0];
        let prev = firstSelected.previousElementSibling;
        
        selected.forEach(b => b.remove());
        
        if (prev) {
            prev.focus();
            prev.classList.add('selected');
        } else if (container.firstElementChild) {
            container.firstElementChild.focus();
            container.firstElementChild.classList.add('selected');
        } else {
            appendMathBlock().focus();
        }
        saveState();
    }
"""

# Insert after toggleThemeBtn setup
text = text.replace("    // Restore Theme", selection_logic + "\n    // Restore Theme")

setup_block_replacement = """
    function setupBlock(el, isMath) {
        el.addEventListener('mousedown', (e) => {
            if (e.shiftKey && lastSelectedBlock) {
                e.preventDefault();
                const blocks = Array.from(container.children);
                const start = blocks.indexOf(lastSelectedBlock);
                const end = blocks.indexOf(el);
                const min = Math.min(start, end);
                const max = Math.max(start, end);
                clearSelection();
                for (let i = min; i <= max; i++) {
                    blocks[i].classList.add('selected');
                }
            } else {
                clearSelection();
                el.classList.add('selected');
                lastSelectedBlock = el;
            }
        });

        el.addEventListener('focus', () => {
            if (!el.classList.contains('selected')) {
                clearSelection();
                el.classList.add('selected');
                lastSelectedBlock = el;
            }
        });

        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const newEl = isMath ? appendMathBlock(null, el.nextSibling) : appendTextBlock(null, el.nextSibling);
                clearSelection();
                newEl.focus();
                saveState();
            } else if (e.key === 'Backspace') {
                const isEmpty = isMath ? el.value === '' : el.innerText.trim() === '';
                if (isEmpty && container.children.length > 1) {
                    const selected = getSelectedBlocks();
                    if (selected.length > 1) return; // handled by document event listener
                    e.preventDefault();
                    const prev = el.previousElementSibling;
                    if (prev) {
                        prev.focus();
                        if (prev.tagName.toLowerCase() === 'math-field') {
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
                const prev = el.previousElementSibling;
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
                const next = el.nextElementSibling;
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
"""

text = re.sub(r'    function setupBlock\(el, isMath\) \{.*?(?=    const savedState = localStorage\.getItem)', setup_block_replacement, text, flags=re.DOTALL)

with open('js/app.js', 'w') as f:
    f.write(text)

