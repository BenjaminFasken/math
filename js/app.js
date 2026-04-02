document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('editor-container');
    const toggleThemeBtn = document.getElementById('toggle-theme');
    const addTextBtn = document.getElementById('add-text');
    const addMathBtn = document.getElementById('add-math');

    // Theme toggle
    toggleThemeBtn.addEventListener('click', () => {
        document.body.classList.toggle('dark-mode');
    });

    function createMathBlock() {
        const mf = document.createElement('math-field');
        mf.classList.add('math-line', 'block');
        setupBlock(mf, true);
        return mf;
    }

    function createTextBlock() {
        const div = document.createElement('div');
        div.contentEditable = "true";
        div.classList.add('text-line', 'block');
        setupBlock(div, false);
        return div;
    }

    // Insert block at end via buttons
    addTextBtn.addEventListener('click', () => {
        const b = createTextBlock();
        container.appendChild(b);
        b.focus();
    });
    
    addMathBtn.addEventListener('click', () => {
        const b = createMathBlock();
        container.appendChild(b);
        b.focus();
    });

    function setupBlock(el, isMath) {
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // Create the same type of block, or default to math
                const newEl = isMath ? createMathBlock() : createTextBlock();
                el.parentNode.insertBefore(newEl, el.nextSibling);
                newEl.focus();
            } else if (e.key === 'Backspace') {
                const isEmpty = isMath ? el.value === '' : el.innerText.trim() === '';
                if (isEmpty && container.children.length > 1) {
                    e.preventDefault();
                    const prev = el.previousElementSibling;
                    if (prev) {
                        prev.focus();
                        if (prev.tagName.toLowerCase() === 'math-field') {
                            prev.executeCommand('moveToMathFieldEnd');
                        } else {
                            // Move cursor to end of text block
                            const range = document.createRange();
                            const sel = window.getSelection();
                            range.selectNodeContents(prev);
                            range.collapse(false);
                            sel.removeAllRanges();
                            sel.addRange(range);
                        }
                    }
                    el.remove();
                }
            } else if (e.key === 'ArrowUp') {
                const prev = el.previousElementSibling;
                if (prev) prev.focus();
            } else if (e.key === 'ArrowDown') {
                const next = el.nextElementSibling;
                if (next) next.focus();
            }
        });
    }

    // Initialize the first math field
    const initialField = container.querySelector('.block');
    if (initialField) {
        setupBlock(initialField, true);
        initialField.focus();
    }
});
