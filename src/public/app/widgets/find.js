/**
 * (c) Antonio Tejada 2022
 * https://github.com/antoniotejada/Trilium-FindWidget
 */

import NoteContextAwareWidget from "./note_context_aware_widget.js";
import appContext from "../services/app_context.js";

const findWidgetDelayMillis = 200;
const waitForEnter = (findWidgetDelayMillis < 0);

// tabIndex=-1 on the checkbox labels is necessary so when clicking on the label
// the focusout handler is called with relatedTarget equal to the label instead
// of undefined. It's -1 instead of > 0, so they don't tabstop
const TPL = `
<div style="contain: none;">
    <div id="findBox" style="padding: 10px; border-top: 1px solid var(--main-border-color); ">
        <input type="text" id="input">
        <label tabIndex="-1" id="caseLabel"><input type="checkbox" id="caseCheck"> case sensitive</label>
        <label tabIndex="-1" id="wordLabel"><input type="checkbox" id="wordCheck"> match words</label>
        <span style="font-weight: bold;" id="curFound">0</span>/<span style="font-weight: bold;" id="numFound">0</span>
    </div>
</div>`;

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const getActiveContextCodeEditor = async () => await appContext.tabManager.getActiveContextCodeEditor();
const getActiveContextTextEditor = async () => await appContext.tabManager.getActiveContextTextEditor();

// ck-find-result and ck-find-result_selected are the styles ck-editor
// uses for highlighting matches, use the same one on CodeMirror
// for consistency
const FIND_RESULT_SELECTED_CSS_CLASSNAME = "ck-find-result_selected";
const FIND_RESULT_CSS_CLASSNAME = "ck-find-result";

export default class FindWidget extends NoteContextAwareWidget {
    doRender() {
        this.$widget = $(TPL);
        this.$findBox = this.$widget.find('#findBox');
        this.$findBox.hide();
        this.$input = this.$widget.find('#input');
        this.$curFound = this.$widget.find('#curFound');
        this.$numFound = this.$widget.find('#numFound');
        this.$caseCheck = this.$widget.find("#caseCheck");
        this.$wordCheck = this.$widget.find("#wordCheck");
        this.findResult = null;
        this.needle = null;

        this.$input.keydown(async e => {
            if ((e.metaKey || e.ctrlKey) && ((e.key === 'F') || (e.key === 'f'))) {
                // If ctrl+f is pressed when the findbox is shown, select the
                // whole input to find
                this.$input.select();
            } else if ((e.key === 'Enter') || (e.key === 'F3')) {
                const needle = this.$input.val();
                if (waitForEnter && (this.needle !== needle)) {
                    await this.performFind(needle);
                }
                const numFound = parseInt(this.$numFound.text());
                const curFound = parseInt(this.$curFound.text()) - 1;

                if (numFound > 0) {
                    let delta =  e.shiftKey ? -1 : 1;
                    let nextFound = curFound + delta;
                    // Wrap around
                    if (nextFound > numFound - 1) {
                        nextFound = 0;
                    } if (nextFound < 0) {
                        nextFound = numFound - 1;
                    }

                    let needle = this.$input.val();
                    this.$curFound.text(nextFound + 1);

                    const note = appContext.tabManager.getActiveContextNote();
                    if (note.type === "code") {
                        const codeEditor = await getActiveContextCodeEditor();
                        const doc = codeEditor.doc;

                        //
                        // Dehighlight current, highlight & scrollIntoView next
                        //

                        let marker = this.findResult[curFound];
                        let pos = marker.find();
                        marker.clear();
                        marker = doc.markText(
                            pos.from, pos.to,
                            { "className" : FIND_RESULT_CSS_CLASSNAME }
                        );
                        this.findResult[curFound] = marker;

                        marker = this.findResult[nextFound];
                        pos = marker.find();
                        marker.clear();
                        marker = doc.markText(
                            pos.from, pos.to,
                            { "className" : FIND_RESULT_SELECTED_CSS_CLASSNAME }
                        );
                        this.findResult[nextFound] = marker;

                        codeEditor.scrollIntoView(pos.from);
                    } else {
                        const textEditor = await getActiveContextTextEditor();

                        // There are no parameters for findNext/findPrev
                        // See https://github.com/ckeditor/ckeditor5/blob/b95e2faf817262ac0e1e21993d9c0bde3f1be594/packages/ckeditor5-find-and-replace/src/findnextcommand.js#L57
                        // curFound wrap around above assumes findNext and
                        // findPrevious wraparound, which is what they do
                        if (delta > 0) {
                            textEditor.execute('findNext');
                        } else {
                            textEditor.execute('findPrevious');
                        }
                    }
                }
                e.preventDefault();
                return false;
            } else if (e.key === 'Escape') {
                const note = appContext.tabManager.getActiveContextNote();
                if (note.type === "code") {
                    const codeEditor = await getActiveContextCodeEditor();
                    codeEditor.focus();
                } else {
                    const textEditor = await getActiveContextTextEditor();
                    textEditor.focus();
                }
            }
        });

        this.$input.on('input', () => {
            // XXX This should clear the previous search immediately in all cases
            //     (the search is stale when waitforenter but also while the
            //     delay is running for non waitforenter case)
            if (!waitForEnter) {
                // Clear the previous timeout if any, it's ok if timeoutId is
                // null or undefined
                clearTimeout(this.timeoutId);

                // Defer the search a few millis so the search doesn't start
                // immediately, as this can cause search word typing lag with
                // one or two-char searchwords and long notes
                // See https://github.com/antoniotejada/Trilium-FindWidget/issues/1
                const needle = this.$input.val();
                const matchCase = this.$caseCheck.prop("checked");
                const wholeWord = this.$wordCheck.prop("checked");
                this.timeoutId = setTimeout(async () => {
                    this.timeoutId = null;
                    await this.performFind(needle, matchCase, wholeWord);
                }, findWidgetDelayMillis);
            }
        });

        this.$caseCheck.change(() => this.performFind());
        this.$wordCheck.change(() => this.performFind());

        // Note blur doesn't bubble to parent div, but the parent div needs to
        // detect when any of the children are not focused and hide. Use
        // focusout instead which does bubble to the parent div.
        this.$findBox.focusout(async (e) => {
            // e.relatedTarget is the new focused element, note it can be null
            // if nothing is being focused
            if (this.$findBox[0].contains(e.relatedTarget)) {
                // The focused element is inside this div, ignore
                return;
            }
            this.$findBox.hide();

            // Restore any state, if there's a current occurrence clear markers
            // and scroll to and select the last occurrence

            // XXX Switching to a different tab with crl+tab doesn't invoke
            //     blur and leaves a stale search which then breaks when
            //     navigating it
            const numFound = parseInt(this.$numFound.text());
            const curFound = parseInt(this.$curFound.text()) - 1;
            const note = appContext.tabManager.getActiveContextNote();
            if (note.type === "code") {
                const codeEditor = await getActiveContextCodeEditor();
                if (numFound > 0) {
                    const doc = codeEditor.doc;
                    const pos = this.findResult[curFound].find();
                    // Note setting the selection sets the cursor to
                    // the end of the selection and scrolls it into
                    // view
                    doc.setSelection(pos.from, pos.to);
                    // Clear all markers
                    codeEditor.operation(() => {
                        for (let i = 0; i < this.findResult.length; ++i) {
                            let marker = this.findResult[i];
                            marker.clear();
                        }
                    });
                }
                // Restore the highlightSelectionMatches setting
                codeEditor.setOption("highlightSelectionMatches", this.oldHighlightSelectionMatches);
                this.findResult = null;
                this.needle = null;
            } else {
                if (numFound > 0) {
                    const textEditor = await getActiveContextTextEditor();
                    // Clear the markers and set the caret to the
                    // current occurrence
                    const model = textEditor.model;
                    const range = this.findResult.results.get(curFound).marker.getRange();
                    // From
                    // https://github.com/ckeditor/ckeditor5/blob/b95e2faf817262ac0e1e21993d9c0bde3f1be594/packages/ckeditor5-find-and-replace/src/findandreplace.js#L92
                    // XXX Roll our own since already done for codeEditor and
                    //     will probably allow more refactoring?
                    let findAndReplaceEditing = textEditor.plugins.get('FindAndReplaceEditing');
                    findAndReplaceEditing.state.clear(model);
                    findAndReplaceEditing.stop();
                    model.change(writer => {
                        writer.setSelection(range, 0);
                    });
                    textEditor.editing.view.scrollToTheSelection();
                    this.findResult = null;
                    this.needle = null;
                } else {
                    this.findResult = null;
                    this.needle = null;
                }
            }
        });

        return this.$widget;
    }

    async findInTextEvent() {
        const note = appContext.tabManager.getActiveContextNote();
        // Only writeable text and code supported
        const readOnly = note.getAttribute("label", "readOnly");
        if (!readOnly && (note.type === "code" || note.type === "text")) {
            if (this.$findBox.is(":hidden")) {

                this.$findBox.show();
                this.$input.focus();
                this.$numFound.text(0);
                this.$curFound.text(0);

                // Initialize the input field to the text selection, if any
                if (note.type === "code") {
                    const codeEditor = await getActiveContextCodeEditor();

                    // highlightSelectionMatches is the overlay that highlights
                    // the words under the cursor. This occludes the search
                    // markers style, save it, disable it. Will be restored when
                    // the focus is back into the note
                    this.oldHighlightSelectionMatches = codeEditor.getOption("highlightSelectionMatches");
                    codeEditor.setOption("highlightSelectionMatches", false);

                    // Fill in the findbox with the current selection if any
                    const selectedText = codeEditor.getSelection()
                    if (selectedText !== "") {
                        this.$input.val(selectedText);
                    }
                    // Directly perform the search if there's some text to find,
                    // without delaying or waiting for enter
                    const needle = this.$input.val();
                    if (needle !== "") {
                        this.$input.select();
                        await this.performFind(needle);
                    }
                } else {
                    const textEditor = await getActiveContextTextEditor();

                    const selection = textEditor.model.document.selection;
                    const range = selection.getFirstRange();

                    for (const item of range.getItems()) {
                        // Fill in the findbox with the current selection if
                        // any
                        this.$input.val(item.data);
                        break;
                    }
                    // Directly perform the search if there's some text to
                    // find, without delaying or waiting for enter
                    const needle = this.$input.val();
                    if (needle !== "") {
                        this.$input.select();
                        await this.performFind(needle);
                    }
                }
            }
        }
    }

    async performTextNoteFind(needle, matchCase, wholeWord) {
        // Do this even if the needle is empty so the markers are cleared and
        // the counters updated
        const textEditor = await getActiveContextTextEditor();
        const model = textEditor.model;
        let findResult = null;
        let numFound = 0;
        let curFound = -1;

        // Clear
        const findAndReplaceEditing = textEditor.plugins.get('FindAndReplaceEditing');
        findAndReplaceEditing.state.clear(model);
        findAndReplaceEditing.stop();
        if (needle !== "") {
            // Parameters are callback/text, options.matchCase=false, options.wholeWords=false
            // See https://github.com/ckeditor/ckeditor5/blob/b95e2faf817262ac0e1e21993d9c0bde3f1be594/packages/ckeditor5-find-and-replace/src/findcommand.js#L44
            // XXX Need to use the callback version for regexp
            // needle = escapeRegExp(needle);
            // let re = new RegExp(needle, 'gi');
            // let m = text.match(re);
            // numFound = m ? m.length : 0;
            const options = { "matchCase" : matchCase, "wholeWords" : wholeWord };
            findResult = textEditor.execute('find', needle, options);
            numFound = findResult.results.length;
            // Find the result beyond the cursor
            const cursorPos = model.document.selection.getLastPosition();
            for (let i = 0; i < findResult.results.length; ++i) {
                const marker = findResult.results.get(i).marker;
                const fromPos = marker.getStart();
                if (fromPos.compareWith(cursorPos) !== "before") {
                    curFound = i;
                    break;
                }
            }
        }

        this.findResult = findResult;
        this.$numFound.text(numFound);
        // Calculate curfound if not already, highlight it as
        // selected
        if (numFound > 0) {
            curFound = Math.max(0, curFound);
            // XXX Do this accessing the private data?
            // See
            // https://github.com/ckeditor/ckeditor5/blob/b95e2faf817262ac0e1e21993d9c0bde3f1be594/packages/ckeditor5-find-and-replace/src/findnextcommand.js
            for (let i = 0 ; i < curFound; ++i) {
                textEditor.execute('findNext', needle);
            }
        }
        this.$curFound.text(curFound + 1);
        this.needle = needle;
    }

    async performCodeNoteFind(needle, matchCase, wholeWord) {
        let findResult = null;
        let numFound = 0;
        let curFound = -1;

        // See https://codemirror.net/addon/search/searchcursor.js for tips
        const codeEditor = await getActiveContextCodeEditor();
        const doc = codeEditor.doc;
        const text = doc.getValue();

        // Clear all markers
        if (this.findResult != null) {
            const findWidget = this;
            codeEditor.operation(() => {
                for (let i = 0; i < this.findResult.length; ++i) {
                    const marker = this.findResult[i];
                    marker.clear();
                }
            });
        }

        if (needle !== "") {
            needle = escapeRegExp(needle);

            // Find and highlight matches
            // Find and highlight matches
            // XXX Using \\b and not using the unicode flag probably doesn't
            //     work with non ascii alphabets, findAndReplace uses a more
            //     complicated regexp, see
            //     https://github.com/ckeditor/ckeditor5/blob/b95e2faf817262ac0e1e21993d9c0bde3f1be594/packages/ckeditor5-find-and-replace/src/utils.js#L145
            const wholeWordChar = wholeWord ? "\\b" : "";
            const re = new RegExp(wholeWordChar + needle + wholeWordChar,
                'g' + (matchCase ? '' : 'i'));
            let curLine = 0;
            let curChar = 0;
            let curMatch = null;
            findResult = [];
            // All those markText take several seconds on eg this ~500-line
            // script, batch them inside an operation so they become
            // unnoticeable. Alternatively, an overlay could be used, see
            // https://codemirror.net/addon/search/match-highlighter.js ?
            codeEditor.operation(() => {
                for (let i = 0; i < text.length; ++i) {
                    // Fetch next match if it's the first time or
                    // if past the current match start
                    if ((curMatch == null) || (curMatch.index < i)) {
                        curMatch = re.exec(text);
                        if (curMatch == null) {
                            // No more matches
                            break;
                        }
                    }
                    // Create a non-selected highlight marker for the match, the
                    // selected marker highlight will be done later
                    if (i === curMatch.index) {
                        let fromPos = { "line" : curLine, "ch" : curChar };
                        // XXX If multiline is supported, this needs to
                        //     recalculate curLine since the match may span
                        //     lines
                        let toPos = { "line" : curLine, "ch" : curChar + curMatch[0].length};
                        // XXX or css = "color: #f3"
                        let marker = doc.markText( fromPos, toPos, { "className" : FIND_RESULT_CSS_CLASSNAME });
                        findResult.push(marker);

                        // Set the first match beyond the cursor as current
                        // match
                        if (curFound === -1) {
                            const cursorPos = codeEditor.getCursor();
                            if ((fromPos.line > cursorPos.line) ||
                                ((fromPos.line === cursorPos.line) &&
                                    (fromPos.ch >= cursorPos.ch))){
                                curFound = numFound;
                            }
                        }

                        numFound++;
                    }
                    // Do line and char position tracking
                    if (text[i] === "\n") {
                        curLine++;
                        curChar = 0;
                    } else {
                        curChar++;
                    }
                }
            });
        }

        this.findResult = findResult;
        this.$numFound.text(numFound);
        // Calculate curfound if not already, highlight it as selected
        if (numFound > 0) {
            curFound = Math.max(0, curFound)
            let marker = findResult[curFound];
            let pos = marker.find();
            codeEditor.scrollIntoView(pos.to);
            marker.clear();
            findResult[curFound] = doc.markText( pos.from, pos.to,
                { "className" : FIND_RESULT_SELECTED_CSS_CLASSNAME }
            );
        }
        this.$curFound.text(curFound + 1);
        this.needle = needle;
    }

    /**
     * Perform the find and highlight the find results.
     *
     * @param needle {string} optional parameter, taken from the input box if
     *        missing.
     * @param matchCase {boolean} optional parameter, taken from the checkbox
     *        state if missing.
     * @param wholeWord {boolean} optional parameter, taken from the checkbox
     *        state if missing.
     */
    async performFind(needle, matchCase, wholeWord) {
        needle = (needle === undefined) ? this.$input.val() : needle;
        matchCase = (matchCase === undefined) ? this.$caseCheck.prop("checked") : matchCase;
        wholeWord = (wholeWord === undefined) ? this.$wordCheck.prop("checked") : wholeWord;
        const note = appContext.tabManager.getActiveContextNote();
        if (note.type === "code") {
            await this.performCodeNoteFind(needle, matchCase, wholeWord);
        } else {
            await this.performTextNoteFind(needle, matchCase, wholeWord);
        }
    }

    isEnabled() {
        return super.isEnabled() && (this.note.type === 'text' || this.note.type === 'code');
    }

    async entitiesReloadedEvent({loadResults}) {
        if (loadResults.isNoteContentReloaded(this.noteId)) {
            this.refresh();
        }
    }
}