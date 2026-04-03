document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('editor-container');
    const toggleThemeBtn = document.getElementById('toggle-theme');
    const addTextBtn = document.getElementById('add-text');
    const addMathBtn = document.getElementById('add-math');
    const saveBtn = document.getElementById('btn-save');
    const loadBtn = document.getElementById('btn-load');
    const fileInput = document.getElementById('file-input');

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
        for (const el of container.children) {
            if (el.tagName.toLowerCase() === 'math-field') {
                if (el.value.trim() !== '') content.push(`$$ ${el.value} $$`);
            } else if (el.classList.contains('text-line')) {
                if (el.innerText.trim() !== '') content.push(el.innerText.trim());
            }
        }
        return content.join('\n\n');
    }

    function loadDocString(text) {
        container.innerHTML = '';
        const chunks = text.split(/\n\s*\n/);
        chunks.forEach(chunk => {
            chunk = chunk.trim();
            if (!chunk) return;
            if (chunk.startsWith('$$') && chunk.endsWith('$$')) {
                const latex = chunk.slice(2, -2).trim();
                const mf = createMathBlock();
                mf.value = latex;
                container.appendChild(mf);
            } else {
                const tb = createTextBlock();
                tb.innerText = chunk;
                container.appendChild(tb);
            }
        });
        if (container.children.length === 0) {
            container.appendChild(createMathBlock());
        }
    }

    function saveState() {
        localStorage.setItem('docState', getDocString());
    }

    // Auto save on input
    container.addEventListener('input', () => {
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
            loadDocString(ev.target.result);
            saveState();
        };
        reader.readAsText(file);
        
        fileInput.value = '';
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

    addTextBtn.addEventListener('click', () => {
        const b = createTextBlock();
        container.appendChild(b);
        b.focus();
        saveState();
    });
    
    addMathBtn.addEventListener('click', () => {
        const b = createMathBlock();
        container.appendChild(b);
        b.focus();
        saveState();
    });

    function setupBlock(el, isMath) {
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const newEl = isMath ? createMathBlock() : createTextBlock();
                el.parentNode.insertBefore(newEl, el.nextSibling);
                newEl.focus();
                saveState();
            } else if (e.key === 'Backspace') {
                const isEmpty = isMath ? el.value === '' : el.innerText.trim() === '';
                if (isEmpty && container.children.length > 1) {
                    e.preventDefault();
                    const prev = el.previousElementSibling;
                    if (prev) {
                        prev.focus();
                        if (prev.tagName.toLowerCase() === 'math-field') {
                            prev.executeCommand('moveToMathfieldEnd'); // Fixed capitalization
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
                if (prev) prev.focus();
            } else if (e.key === 'ArrowDown') {
                const next = el.nextElementSibling;
                if (next) next.focus();
            }
        });
    }

    const savedState = localStorage.getItem('docState');
    if (savedState) {
        loadDocString(savedState);
    } else {
        const initialField = createMathBlock();
        container.appendChild(initialField);
        initialField.focus();
    }
});
