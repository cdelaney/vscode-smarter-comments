/*
	Smarter Comments
	extension.js

	Insert and remove comments in the style that fits, with per-language
	defaults, accurate target-text detection whether or not a selection
	is made, and a single global uncomment command.
*/

/*
	===============================================================
	======= BEGIN configuration block 1 of 2 (module level) =======
	=============================================================== */

/**
 * Every comment style this extension supports. Three kinds:
 * 'block' (open marker on its own line, close on its own line — JSDoc's
 * own linePrefix flattens every content line to one shared indent;
 * without linePrefix, content lines are left untouched), 'line' (prefix
 * applied independently to each line), 'inline' (open/close wrapped
 * around the whole target as one string).
 *
 * A comment collapsed onto one line could validly be 'inline' or a
 * self-contained 'block' instance for the same markers — declaration
 * order below resolves the tie (c-multiline-inline before
 * c-multiline-block, html-inline before html-block), so a collapsed
 * comment is always read as the inline style.
 *
 * nativeOnly (line-kind styles only): restricts a style to candidacy
 * only when document.languageId is listed, or the document is unsaved —
 * for a marker shape too easily confused with ordinary punctuation
 * outside its own language (SQL's "--", VB's "'").
 *
 * command: this style's own plain-English label, not read at runtime —
 * package.json's own title/category are what VS Code actually uses.
 * Kept here as a cross-reference to keep the two in sync by eye.
 */
const COMMENT_STYLES = {
	'jsdoc': {
		kind:			'block',
		open:			'/**',
		linePrefix:	'*',
		close:		'*/',
		command:		'JSDoc',
	},
	'c-multiline-inline': {
		kind:		'inline',
		open:		'/*',
		close:	'*/',
		command:	'C Multiline (inline style)',
	},
	'c-multiline-block': {
		kind:		'block',
		open:		'/*',
		close:	'*/',
		command:	'C Multiline (block style)',
	},
	'js-single': {
		kind:		'line',
		prefix:	'//',
		command:	'C Single Line',
	},
	'perl-single': {
		kind:		'line',
		prefix:	'#',
		command:	'Perl',
	},
	'sql-single': {
		kind:			'line',
		prefix:		'--',
		nativeOnly:	[ 'sql' ],
		command:		'SQL',
	},
	'vb-single': {
		kind:			'line',
		prefix:		'\'',
		nativeOnly:	[ 'vb' ],
		command:		'Visual Basic',
	},
	/*
	 * nativeOnly matters especially here: ";" is a statement terminator
	 * in many ordinary languages, never a comment marker there.
	 */
	'ini-single': {
		kind:			'line',
		prefix:		';',
		nativeOnly:	[ 'ini', 'commonlisp', 'clojure' ],
		command:		'INI',
	},
	'html-inline': {
		kind:		'inline',
		open:		'<!--',
		close:	'-->',
		command:	'HTML (inline style)',
	},
	'html-block': {
		kind:		'block',
		open:		'<!--',
		close:	'-->',
		command:	'HTML (block style)',
	},
};

/**
 * Whether, and how, mixed leading indentation is normalised — falsy
 * (empty string, so it stays directly usable as a JS falsy check)
 * leaves whitespace as found; 'tabs' converts space runs to the
 * equivalent tabs; 'spaces' mirrors that in the other direction.
 * Defaults to leave-as-is, since a published extension can't assume
 * every user shares one preference.
 */
const NORMALISE_LEADING_WHITESPACE_DEFAULT = '';
var normaliseLeadingWhitespace = NORMALISE_LEADING_WHITESPACE_DEFAULT;

/**
 * Number of spaces treated as equivalent to one tab when normalising.
 */
const SPACES_PER_TAB = 3;

/**
 * When a line-style comment is applied to more than one line at once, blank
 * lines among them are left blank rather than commented — a comment marker
 * on an otherwise-empty line isn't doing anything, so there's nothing to
 * mark there when it's part of a larger block. Does not apply when the
 * target is a single line (the common case of commenting a blank line to
 * type into immediately) — that always gets the marker, regardless of this
 * setting.
 */
const SKIP_BLANK_LINES_IN_MULTILINE_DEFAULT = true;
var skipBlankLinesInMultiline = SKIP_BLANK_LINES_IN_MULTILINE_DEFAULT;

/**
 * Restricts which styles implicit "is something already commented here"
 * detection considers, keyed by document.languageId — e.g. a CSS file
 * never has SQL-style "--" comments, avoiding a false match against a
 * CSS custom property. A language not listed (including HTML,
 * deliberately, since it commonly embeds PHP/JS/CSS) gets no
 * restriction. Only affects implicit detection, never an explicit
 * command — "Comments: SQL" in a .js file still works.
 */
const LANGUAGE_ALLOWED_STYLES = {
	'javascript':			[ 'jsdoc', 'c-multiline-inline', 'c-multiline-block', 'js-single' ],
	'javascriptreact':	[ 'jsdoc', 'c-multiline-inline', 'c-multiline-block', 'js-single' ],
	'typescript':			[ 'jsdoc', 'c-multiline-inline', 'c-multiline-block', 'js-single' ],
	'typescriptreact':	[ 'jsdoc', 'c-multiline-inline', 'c-multiline-block', 'js-single' ],
	'css':					[ 'jsdoc', 'c-multiline-inline', 'c-multiline-block' ],
	'scss':					[ 'jsdoc', 'c-multiline-inline', 'c-multiline-block', 'js-single' ],
	'less':					[ 'jsdoc', 'c-multiline-inline', 'c-multiline-block', 'js-single' ],
	'perl':					[ 'perl-single' ],
	'sql':					[ 'perl-single', 'sql-single', 'jsdoc', 'c-multiline-inline', 'c-multiline-block' ],
	'php':					[ 'jsdoc', 'c-multiline-inline', 'c-multiline-block', 'js-single', 'perl-single' ],
	'vb':						[ 'vb-single' ],
	'ini':					[ 'ini-single' ],
	'commonlisp':			[ 'ini-single' ],
	'clojure':				[ 'ini-single' ],
	'apacheconf':			[ 'perl-single' ],
	/*
	 * VS Code's own built-in "ini" extension registers a separate
	 * "properties" language too, covering .conf/.gitattributes/
	 * .gitconfig/.gitmodules/.editorconfig/.env — its own comment
	 * character is "#", matching perl-single.
	 */
	'properties':			[ 'perl-single' ],
};

/**
 * Which styles are valid DEFAULT choices for a language — used to
 * validate a user's own languageDefault override, and as the source for
 * each language's own Settings UI dropdown. Deliberately separate from
 * LANGUAGE_ALLOWED_STYLES above: that table answers a different question
 * (which styles implicit detection should recognise) and, for html
 * specifically, is intentionally unrestricted — wrong as a default-style
 * choice, where only html-inline/html-block make sense. A language
 * absent here (everything but html) falls through to
 * LANGUAGE_ALLOWED_STYLES' own entry, since the two coincide for them.
 */
const LANGUAGE_DEFAULT_STYLE_OPTIONS = {
	'html': [ 'html-inline', 'html-block' ],
};

function getLanguageDefaultStyleOptions( languageId ) {
	return LANGUAGE_DEFAULT_STYLE_OPTIONS[ languageId ] || LANGUAGE_ALLOWED_STYLES[ languageId ] || [];
}

/**
 * Which characters genuinely open a quoted string, keyed by
 * document.languageId — not a universal rule. VB uses ' exclusively as
 * its comment marker, never as a string delimiter, so treating ' as a
 * quote character there would misread an apostrophe in a VB comment
 * (e.g. "O'Brien's") as opening a string. A language not listed gets
 * the general default (both ' and ").
 */
const LANGUAGE_QUOTE_CHARS = {
	'vb': [ '"' ],
};

function getQuoteChars( languageId ) {
	return LANGUAGE_QUOTE_CHARS[ languageId ] || [ '\'', '"' ];
}

/**
 * The style the bare default command falls back to when nothing more
 * specific applies — no language-specific default, no per-language
 * user override either.
 */
// const DEFAULT_COMMENT_STYLE = 'html-inline';
const DEFAULT_COMMENT_STYLE = 'jsdoc';

/**
 * The style the bare default command applies, keyed by
 * document.languageId — falls through to DEFAULT_COMMENT_STYLE if
 * unlisted. Only consulted for the bare command; every named command
 * always applies exactly the style it names, regardless of file type.
 */
const LANGUAGE_DEFAULT_STYLE = {
	'html':			'html-block',
	'perl':			'perl-single',
	// 'sql':	'sql-single',
	'sql':			'perl-single',
	'css':			'c-multiline-block',
	'vb':				'vb-single',
	'ini':			'ini-single',
	'commonlisp':	'ini-single',
	'clojure':		'ini-single',
	'apacheconf':	'perl-single',
	'properties':	'perl-single',
};

/**
 * Best-effort fallback for files VS Code has no real language opinion
 * about — document.languageId 'plaintext' or falsy — only consulted
 * after LANGUAGE_DEFAULT_STYLE's own lookup has failed, and only for
 * genuinely unclassified files, never overriding a real classification.
 * Filename-pattern-based rather than tied to a specific extension being
 * installed, so it still works if the user doesn't have a dedicated
 * language extension for that file type.
 */
const FILENAME_FALLBACK_STYLE = [
	{ pattern: /\.htaccess/i,	style: 'perl-single' },
	{ pattern: /\.htgroups/i,	style: 'perl-single' },
	{ pattern: /\.htpasswd/i,	style: 'perl-single' },
	{ pattern: /\.conf$/i,		style: 'perl-single' },
	{ pattern: /\.xyz$/i,		style: 'perl-single' },
];

FILENAME_FALLBACK_STYLE.forEach( function( entry ) {
	if ( ! COMMENT_STYLES[ entry.style ] ) {
		throw new Error( 'Invalid comment style specified in FILENAME_FALLBACK_STYLE for pattern ' + entry.pattern + '.' );
	}
} );

/**
 * Checks a document's own filename (not its full path) against
 * FILENAME_FALLBACK_STYLE's patterns in order, returning the first
 * match's style, or null if nothing matches.
 */
function getFilenameFallbackStyle( document ) {

	var fileName	= document.fileName || '';
	var baseName	= fileName.split( /[\\/]/ ).pop();

	var match = FILENAME_FALLBACK_STYLE.filter( function( entry ) {
		return entry.pattern.test( baseName );
	} )[0];

	return match ? match.style : null;

}

/**
 * Languages where implicit-detection's own collision guard should stay
 * strict even without a LANGUAGE_ALLOWED_STYLES entry to narrow things —
 * because the language can genuinely embed other, riskier ones (HTML
 * commonly contains PHP/JS/CSS).
 */
const LANGUAGE_EMBEDS_OTHER_LANGUAGES = [ 'html' ];

/*
	===============================================================
	======== END configuration block 1 of 2 (module level) ========
	=============================================================== */

/**
 * Uncomment's own candidate style list — unrestricted by
 * LANGUAGE_ALLOWED_STYLES above, since recognising a real comment
 * doesn't depend on what's idiomatic to add for this file type. A style
 * flagged nativeOnly is still excluded unless the file's own language
 * matches, or the file is unsaved.
 */
function getUncommentStyleKeys( document ) {

	return Object.keys( COMMENT_STYLES ).filter( function( key ) {

		var nativeOnly = COMMENT_STYLES[ key ].nativeOnly;

		if ( ! nativeOnly ) { return true; }

		return document.isUntitled || nativeOnly.indexOf( document.languageId ) !== -1;

	} );

}

const vscode = require( 'vscode' );

/**
 * Prefixes every status bar message and modal, e.g. "[Smarter Comments] ".
 */
function getScriptPrefix( name ) {
	return name ? `[${name}] ` : '';
}

/**
 * Unconditional error modal, always shown regardless of
 * outputConfirmationModal — unlike finish()'s own, settings-gated one.
 */
async function showErrorModal( message ) {
	await vscode.window.showErrorMessage( message, { modal: true }, 'OK' );
}

/**
 * Unconditional info modal — the display mechanism behind finish()'s
 * own settings-gated confirmation.
 */
async function showInfoModal( message ) {
	await vscode.window.showInformationMessage( message, { modal: true }, 'OK' );
}

/**
 * Runs whichever action was invoked — a specific comment style's own
 * command, the bare default command (requestedAction === null,
 * resolved per-file via resolveLanguageDefaultStyle()), Uncomment, or
 * Remove or Uncomment Trailing Comments. Registered once per command in
 * activate() further down.
 */
async function runCommand( requestedAction ) {

	const scriptNameStub	= 'Smarter Comments';
	const messageDuration	= 6000;

	const config = vscode.workspace.getConfiguration( 'smarterComments' );

	/*
	 * Governs only the confirmation modal (see finish() below) — the status bar message always shows regardless
	 */
	const outputConfirmationModal = config.get( 'outputConfirmationModal', false );

	/*
	 * Whether Uncomment also checks for trailing comments. Doesn't affect
	 * Remove Trailing Comments.
	 */
	const removeTrailingComments = config.get( 'askRemoveOrUncommentTrailingComments', true );

	/*
	 * Whether a genuine, non-empty selection stays selected after an edit
	 * — see finishSelection()'s own comment for the full reasoning behind
	 * what "stays selected" actually means here.
	 */
	const preserveSelectionAfterEdit = config.get( 'preserveSelectionAfterEdit', true );

	/*
	 * Reassigns the module-level var (not a local const) since
	 * normaliseWhitespace() and its callers are module-level functions
	 * with no closure access to anything declared inside this function.
	 */
	normaliseLeadingWhitespace = config.get( 'normaliseLeadingWhitespace', '' );

	const scriptPrefix	= getScriptPrefix( scriptNameStub );
	const editor			= vscode.window.activeTextEditor;

	if ( ! editor ) {
		await showErrorModal( scriptPrefix + 'No active editor.' );
		return;
	}

	const document		= editor.document;
	const selection	= editor.selection;

	/*
	 * Fails loudly if LANGUAGE_DEFAULT_STYLE itself is misconfigured — a
	 * bad entry here is a genuine bug, unlike a user's own settings
	 * override, which falls back silently instead.
	 */
	for ( var languageId in LANGUAGE_DEFAULT_STYLE ) {
		if ( getLanguageDefaultStyleOptions( languageId ).indexOf( LANGUAGE_DEFAULT_STYLE[ languageId ] ) === -1 ) {
			await showErrorModal( 'Invalid comment style specified for ' + languageId + '.' );
			return;
		}
	}

	/**
	 * Shows the confirmation modal only if outputConfirmationModal is on;
	 * always shows the status bar message regardless. Error modals never
	 * go through this — they're always unconditional.
	 */
	async function finish( message ) {

		if ( typeof outputConfirmationModal !== 'undefined' && outputConfirmationModal ) {
			await showInfoModal( message );
		}

		vscode.window.setStatusBarMessage( message, messageDuration );

	}

	/**
	 * The shared "trailing comments found" modal, used by both cursor-only
	 * and selection-based Uncomment. Returns 'Remove', 'Uncomment', or
	 * undefined if dismissed. Remove deletes the trailing comment(s)
	 * entirely; Uncomment exposes their content instead, normalising the
	 * separating whitespace the same way leading indent is normalised.
	 * Dismissing aborts the whole operation, including any other,
	 * non-trailing matches found alongside them.
	 */
	async function askRemoveTrailingComments() {

		return await vscode.window.showInformationMessage(
			'Trailing comments found. Remove or just uncomment?',
			{ modal: true },
			'Remove',
			'Uncomment'
		);

	}

	/*
	 * Initial target range: selection expanded to whole lines, or the
	 * current line if nothing is selected. Both boundaries need a check
	 * for a selection edge landing exactly at a line break rather than on
	 * real content — otherwise a boundary line with nothing of it
	 * actually selected gets wrongly included in the target.
	 */
	var startLine, endLine;

	if ( ! selection.isEmpty ) {

		startLine	= ( selection.start.character === document.lineAt( selection.start.line ).text.length && selection.start.line < selection.end.line )
						? selection.start.line + 1
						: selection.start.line;

		endLine		= ( selection.end.character === 0 && selection.end.line > startLine )
						? selection.end.line - 1
						: selection.end.line;

	} else {
		startLine	= selection.active.line;
		endLine		= startLine;
	}

	var allLines = [];
	for ( var i = 0; i < document.lineCount; i++ ) { allLines.push( document.lineAt( i ).text ); }

	/**
	 * Resolves the style the bare default command applies for a given
	 * document — the user's own per-language override if set and valid,
	 * otherwise LANGUAGE_DEFAULT_STYLE's hardcoded entry, otherwise a
	 * filename-pattern best guess, otherwise resolveGlobalDefaultStyle().
	 * "Valid" means both a real style key and idiomatically appropriate
	 * for this language as a default (per getLanguageDefaultStyleOptions())
	 * — an override failing either check is silently ignored, falling
	 * through as if nothing had been set.
	 */
	function resolveLanguageDefaultStyle( document ) {

		var override			= vscode.workspace.getConfiguration( 'smarterComments.languageDefault' ).get( document.languageId );
		var allowedForLanguage	= getLanguageDefaultStyleOptions( document.languageId );

		if ( override && COMMENT_STYLES[ override ] && allowedForLanguage.indexOf( override ) !== -1 ) {
			return override;
		}

		if ( LANGUAGE_DEFAULT_STYLE[ document.languageId ] ) {
			return LANGUAGE_DEFAULT_STYLE[ document.languageId ];
		}

		if ( document.languageId === 'plaintext' || ! document.languageId ) {

			var filenameFallback = getFilenameFallbackStyle( document );

			if ( filenameFallback ) { return filenameFallback; }

		}

		return resolveGlobalDefaultStyle();

	}

	/**
	 * Resolves the global fallback style — the user's own
	 * smarterComments.defaultStyle override if set and valid, otherwise
	 * DEFAULT_COMMENT_STYLE.
	 */
	function resolveGlobalDefaultStyle() {

		var override = vscode.workspace.getConfiguration( 'smarterComments' ).get( 'defaultStyle' );

		if ( override && COMMENT_STYLES[ override ] ) { return override; }

		return DEFAULT_COMMENT_STYLE;

	}

	/*
	 * The bare default command (requestedAction === null) applies
	 * resolveLanguageDefaultStyle()'s own result. Every other,
	 * specifically-invoked command always applies exactly the action it
	 * was registered with, regardless of file type.
	 */
	var action = ( requestedAction === null )
		? resolveLanguageDefaultStyle( document )
		: requestedAction;

	/*
	 * Restricts implicit "what's already here" detection to styles valid
	 * for the current file type — null for an unlisted language, meaning
	 * no restriction.
	 */
	var allowedStyleKeys = LANGUAGE_ALLOWED_STYLES[ document.languageId ] || null;

	/*
	 * Whether line-style detection enforces the "must have a space after
	 * decoration" collision guard — true only for languages known to
	 * embed other, riskier ones (html).
	 */
	var strictDetection = LANGUAGE_EMBEDS_OTHER_LANGUAGES.indexOf( document.languageId ) !== -1;

	/*
	 * Replaces document lines [fromLine, toLine] with newLines, then
	 * collapses the cursor to a single point — the end of the last
	 * replaced line by default, or cursorOverride's own { line,
	 * character } position (relative to fromLine) instead, used for a
	 * fresh block comment on a blank line, landing mid-comment ready to
	 * type rather than on the closing marker line.
	 */
	async function replaceLines( fromLine, toLine, newLines, cursorOverride ) {

		var range = new vscode.Range(
			document.lineAt( fromLine ).range.start,
			document.lineAt( toLine ).range.end
		);

		var newText = newLines.join( '\n' );

		await editor.edit( function( editBuilder ) { editBuilder.replace( range, newText ); } );

		var newEndLine	= fromLine + newLines.length - 1;
		var lastLine	= newLines[ newLines.length - 1 ];
		var trueEndPos	= new vscode.Position( newEndLine, lastLine.length );

		/*
		 * fallbackPos is separate from trueEndPos: a fresh, empty insert
		 * needs to land mid-comment (ready to type), not at the comment's
		 * true end.
		 */
		var fallbackPos = trueEndPos;

		if ( cursorOverride ) {
			fallbackPos = new vscode.Position( fromLine + cursorOverride.line, cursorOverride.character );
		}

		finishSelection( range.start, trueEndPos, fallbackPos );

	}

	/**
	 * Governed by preserveSelectionAfterEdit — when the command started
	 * from a genuine, non-empty selection, selects the full range this
	 * edit just affected (startPos to endPos), encompassing the whole
	 * newly-added or newly-revealed content — not the original
	 * selection's own prior coordinates, which would go stale the moment
	 * an edit reshapes the document. Collapses to fallbackPos instead
	 * when the command started from a bare cursor.
	 */
	function finishSelection( startPos, endPos, fallbackPos ) {

		if ( preserveSelectionAfterEdit && ! selection.isEmpty ) {
			editor.selection = new vscode.Selection( startPos, endPos );
		} else {
			var pos = ( fallbackPos !== undefined ) ? fallbackPos : endPos;
			editor.selection = new vscode.Selection( pos, pos );
		}

	}

	/*
	 * Inserts a brand-new comment on a freshly-created line adjacent to an
	 * existing marker-based comment — never touching the existing comment
	 * itself. edge 'before': new comment goes above it. edge 'after':
	 * below it. Indent always matches the existing comment's own OPEN
	 * line, never its close line — a linePrefix (JSDoc) close line's own
	 * leading space is a structural separator, not real indentation, and
	 * would be misread as such. The cursor lands ready to type, at a
	 * position appropriate to the new comment's own kind (mid-content for
	 * block, after the open marker's space for inline, end of line for
	 * line-kind).
	 */
	async function insertAdjacentComment( edge, existing, style ) {

		var indent		= normaliseWhitespace( getLeadingWhitespace( allLines[ existing.startLine ] ) );
		var newLines	= addComment( [ '' ], style, indent, strictDetection );
		var newText		= newLines.join( '\n' );

		var insertBaseLine;

		if ( edge === 'before' ) {

			var insertPos = new vscode.Position( existing.startLine, 0 );
			await editor.edit( function( editBuilder ) { editBuilder.insert( insertPos, newText + '\n' ); } );

			insertBaseLine = existing.startLine;

		} else {

			var insertPos = document.lineAt( existing.endLine ).range.end;
			await editor.edit( function( editBuilder ) { editBuilder.insert( insertPos, '\n' + newText ); } );

			insertBaseLine = existing.endLine + 1;

		}

		var cursorLine, cursorChar;

		if ( style.kind === 'block' ) {
			cursorLine = insertBaseLine + 1;
			cursorChar = newLines[1].length;
		} else if ( style.kind === 'inline' ) {
			cursorLine = insertBaseLine;
			cursorChar = ( indent + style.open + ' ' ).length;
		} else {
			cursorLine = insertBaseLine + newLines.length - 1;
			cursorChar = newLines[ newLines.length - 1 ].length;
		}

		var cursorPos = new vscode.Position( cursorLine, cursorChar );
		editor.selection = new vscode.Selection( cursorPos, cursorPos );

		await finish( scriptPrefix + '1 comment added.' );

	}

	/*
	 * Comments: Uncomment. Deliberately unrestricted by
	 * LANGUAGE_ALLOWED_STYLES, unlike every other command — recognising a
	 * valid comment wherever it appears doesn't depend on what's
	 * idiomatic to add for this file type.
	 *
	 * Cursor-only: finds whatever single comment (whole-line/block, or
	 * trailing as a fallback) is at or around the cursor. Genuine
	 * selection: removes every independent comment found within it via
	 * tokenizeComments(), plus any trailing comments found alongside them.
	 *
	 * A trailing comment found gets special handling — asked whether to
	 * Remove it entirely or just Uncomment it (exposing its content,
	 * normalising the separating whitespace) — governed by
	 * askRemoveOrUncommentTrailingComments; off, it's treated like any
	 * other comment with no separate question asked. Dismissing the
	 * prompt aborts the whole operation. The standalone Remove or
	 * Uncomment Trailing Comments command is unaffected by any of this —
	 * it's a distinct command with its own purpose.
	 */
	if ( action === 'uncomment' ) {

		/*
		 * The whole document is tokenized once — this is what correctly
		 * finds a genuine multi-line comment even when the cursor sits
		 * deep inside it, far from either marker. Cursor-only and
		 * selection-based Uncomment both filter this same segment list
		 * down to what's relevant, rather than running separate detection
		 * passes that could drift out of sync with each other.
		 */
		var uncommentStyleKeys	= getUncommentStyleKeys( document );
		var quoteChars			= getQuoteChars( document.languageId );
		var wholeDocText		= document.getText();
		var allSegments			= tokenizeComments( wholeDocText, uncommentStyleKeys, quoteChars );

		if ( selection.isEmpty ) {

			var cursorOffset = document.offsetAt( selection.active );

			var containingSegment = allSegments.filter( function( seg ) {
				return cursorOffset >= seg.start && cursorOffset <= seg.end;
			} )[0];

			/*
			 * Falls back to whichever single segment shares the cursor's
			 * own line, when nothing strictly contains the cursor — a
			 * trailing comment's span starts at its marker, not the line
			 * start, so a cursor earlier in the line would otherwise find
			 * nothing. Only applies when the line has exactly one
			 * segment.
			 */
			if ( ! containingSegment ) {

				var cursorLineStart	= document.offsetAt( new vscode.Position( selection.active.line, 0 ) );
				var cursorLineEnd		= document.offsetAt( document.lineAt( selection.active.line ).range.end );

				var onCursorLine = allSegments.filter( function( seg ) {
					return seg.start >= cursorLineStart && seg.end <= cursorLineEnd;
				} );

				if ( onCursorLine.length === 1 ) { containingSegment = onCursorLine[0]; }

			}

			if ( ! containingSegment ) {
				await showErrorModal( scriptPrefix + 'No comment found near selection' );
				return;
			}

			/*
			 * On: 'Remove' deletes the comment entirely; 'Uncomment'
			 * exposes its content with the gap normalised — the same
			 * treatment the setting-off case gets, via the same
			 * computeTrailingUncommentEdit() call. Dismissing aborts.
			 */
			var useTrailingUncomment = false;

			if ( containingSegment.isTrailingComment ) {

				if ( removeTrailingComments ) {

					var cursorChoice = await askRemoveTrailingComments();

					if ( ! cursorChoice ) { return; }

					useTrailingUncomment = ( cursorChoice === 'Uncomment' );

				} else {

					useTrailingUncomment = true;

				}

			}

			var edit = useTrailingUncomment
				? computeTrailingUncommentEdit( wholeDocText, containingSegment )
				: computeSegmentEdit( wholeDocText, containingSegment );
			var editRange		= new vscode.Range( document.positionAt( edit.start ), document.positionAt( edit.end ) );

			await editor.edit( function( editBuilder ) { editBuilder.replace( editRange, edit.replacement ); } );

			var cursorStartPos	= document.positionAt( edit.start );
			var cursorEndPos	= document.positionAt( edit.start + edit.replacement.length );
			finishSelection( cursorStartPos, cursorEndPos );

			var cursorMessageNoun = containingSegment.isTrailingComment
				? ( 'trailing comment ' + ( useTrailingUncomment ? 'uncommented' : 'removed' ) )
				: 'comment uncommented';

			await finish( scriptPrefix + '1 ' + cursorMessageNoun + '.' );

			return;

		}

		/*
		 * Selection-based: scoped to segments fully contained within
		 * [startLine, endLine]. A further filter narrows this to the
		 * selection's own raw character boundaries (not the whole-line-
		 * expanded range), so a selection partially covering one comment
		 * while fully covering a different one elsewhere doesn't wrongly
		 * include the partial one. Full containment, not mere overlap —
		 * a selection merely touching two comments without fully
		 * enclosing either uncomments neither.
		 */
		var rangeStartOffset	= document.offsetAt( new vscode.Position( startLine, 0 ) );
		var rangeEndOffset		= document.offsetAt( document.lineAt( endLine ).range.end );

		var scopedSegments = allSegments.filter( function( seg ) {
			return seg.start >= rangeStartOffset && seg.end <= rangeEndOffset;
		} );

		var selStartOffset	= document.offsetAt( selection.start );
		var selEndOffset	= document.offsetAt( selection.end );

		var fullyEnclosedSegments = scopedSegments.filter( function( seg ) {
			return seg.start >= selStartOffset && seg.end <= selEndOffset;
		} );

		/*
		 * A selection can relate to a comment two unambiguous ways: the
		 * comment fully inside the selection (checked above), or the
		 * selection fully inside a single comment (this fallback, for a
		 * comment larger than what's selected). Checked against
		 * allSegments, not scopedSegments, since a multi-line comment can
		 * extend beyond the selection's own whole-line range. Requires
		 * exactly one segment to overlap at all, while also fully
		 * containing the selection — spanning parts of two different
		 * comments stays ambiguous, correctly finding neither.
		 */
		if ( fullyEnclosedSegments.length > 0 ) {
			scopedSegments = fullyEnclosedSegments;
		} else {

			var overlappingSegments = allSegments.filter( function( seg ) {
				return seg.start < selEndOffset && seg.end > selStartOffset;
			} );

			if ( overlappingSegments.length === 1 && overlappingSegments[0].start <= selStartOffset && overlappingSegments[0].end >= selEndOffset ) {
				scopedSegments = overlappingSegments;
			} else {
				scopedSegments = [];
			}

		}

		if ( scopedSegments.length === 0 ) {
			await showErrorModal( scriptPrefix + 'No comment found near selection' );
			return;
		}

		/*
		 * The fallback above can find a segment extending beyond the
		 * original range/offsets — widen them to actually cover whatever
		 * ended up in scopedSegments, or a fallback-found segment gets
		 * truncated at the original, too-narrow boundary.
		 */
		scopedSegments.forEach( function( seg ) {
			rangeStartOffset	= Math.min( rangeStartOffset, seg.start );
			rangeEndOffset		= Math.max( rangeEndOffset, seg.end );
		} );

		var trailingSegments	= scopedSegments.filter( function( s ) { return s.isTrailingComment; } );

		/*
		 * Every found segment is always in play — no "exclude the
		 * trailing ones, keep the rest" outcome; Cancel already covers
		 * "don't touch this". On, with trailing comments present: asks
		 * which treatment they get, same as the cursor-only path. Off:
		 * every trailing comment gets Uncomment's own treatment
		 * automatically, no modal.
		 */
		var useTrailingUncomment = ! removeTrailingComments;

		if ( removeTrailingComments && trailingSegments.length > 0 ) {

			var trailingChoice = await askRemoveTrailingComments();

			if ( ! trailingChoice ) { return; }

			useTrailingUncomment = ( trailingChoice === 'Uncomment' );

		}

		var segmentsToApply = scopedSegments;

		if ( segmentsToApply.length === 0 ) { return; }

		var rangeText = wholeDocText.slice( rangeStartOffset, rangeEndOffset );

		var relativeSegments = segmentsToApply.map( function( seg ) {
			return {
				start:				seg.start - rangeStartOffset,
				end:				seg.end - rangeStartOffset,
				styleKey:			seg.styleKey,
				isTrailingComment:	seg.isTrailingComment
			};
		} );

		var newRangeText = applySegmentEdits( rangeText, relativeSegments, useTrailingUncomment );
		var replaceRange = new vscode.Range( document.positionAt( rangeStartOffset ), document.positionAt( rangeEndOffset ) );

		await editor.edit( function( editBuilder ) { editBuilder.replace( replaceRange, newRangeText ); } );

		var selectionStartPos = document.positionAt( rangeStartOffset );
		var selectionEndPos = document.positionAt( rangeStartOffset + newRangeText.length );
		finishSelection( selectionStartPos, selectionEndPos );

		var regularCount	= scopedSegments.filter( function( s ) { return ! s.isTrailingComment; } ).length,
			trailingCount	= trailingSegments.length,
			messageParts	= [];

		if ( regularCount > 0 ) {
			messageParts.push( regularCount + ' ' + ( regularCount === 1 ? 'comment' : 'comments' ) + ' uncommented' );
		}

		if ( trailingCount > 0 ) {
			var trailingVerb = useTrailingUncomment ? 'uncommented' : 'removed';
			messageParts.push( trailingCount + ' trailing ' + ( trailingCount === 1 ? 'comment' : 'comments' ) + ' ' + trailingVerb );
		}

		var message = scriptPrefix + messageParts.join( ', ' ) + '.';

		await finish( message );

		return;

	}


	/*
	 * Comments: Remove or Uncomment Trailing Comments. Behaves exactly
	 * like Uncomment's own trailing-comment handling, whether reached
	 * this way or found incidentally by Uncomment — asks Remove or
	 * Uncomment, subject to askRemoveOrUncommentTrailingComments. Always
	 * a sweep across a range, never a single cursor target, since there's
	 * no meaningful "nearest trailing comment" the way a cursor targets
	 * one enclosing comment for Uncomment. Uses the same [startLine,
	 * endLine] scope every other command computes.
	 */
	if ( action === 'remove-or-uncomment-trailing-comments' ) {

		var uncommentStyleKeysROUTC	= getUncommentStyleKeys( document );
		var quoteCharsROUTC			= getQuoteChars( document.languageId );
		var wholeDocTextROUTC			= document.getText();
		var allSegmentsROUTC			= tokenizeComments( wholeDocTextROUTC, uncommentStyleKeysROUTC, quoteCharsROUTC );

		var rangeStartOffsetROUTC	= document.offsetAt( new vscode.Position( startLine, 0 ) );
		var rangeEndOffsetROUTC		= document.offsetAt( document.lineAt( endLine ).range.end );

		var scopedTrailingSegments = allSegmentsROUTC.filter( function( seg ) {
			return seg.isTrailingComment && seg.start >= rangeStartOffsetROUTC && seg.end <= rangeEndOffsetROUTC;
		} );

		/*
		 * Same reasoning as Uncomment's own equivalent filter above.
		 * Guarded by ! selection.isEmpty: when empty (cursor-only), start
		 * and end are the same point, which would make containment false
		 * for every segment and wrongly exclude all of them — Uncomment
		 * doesn't need this guard since its cursor-only case is a
		 * separate branch entirely; this command isn't split that way.
		 */
		if ( ! selection.isEmpty ) {

			var selStartOffsetROUTC	= document.offsetAt( selection.start );
			var selEndOffsetROUTC	= document.offsetAt( selection.end );

			var fullyEnclosedTrailingSegments = scopedTrailingSegments.filter( function( seg ) {
				return seg.start >= selStartOffsetROUTC && seg.end <= selEndOffsetROUTC;
			} );

			/*
			 * Same fallback as Uncomment's own equivalent filter above.
			 */
			if ( fullyEnclosedTrailingSegments.length > 0 ) {
				scopedTrailingSegments = fullyEnclosedTrailingSegments;
			} else {

				var overlappingTrailingSegments = allSegmentsROUTC.filter( function( seg ) {
					return seg.isTrailingComment && seg.start < selEndOffsetROUTC && seg.end > selStartOffsetROUTC;
				} );

				if ( overlappingTrailingSegments.length === 1 && overlappingTrailingSegments[0].start <= selStartOffsetROUTC && overlappingTrailingSegments[0].end >= selEndOffsetROUTC ) {
					scopedTrailingSegments = overlappingTrailingSegments;
				} else {
					scopedTrailingSegments = [];
				}

			}

		}

		if ( scopedTrailingSegments.length === 0 ) {
			await showErrorModal( scriptPrefix + 'No trailing comments found.' );
			return;
		}

		/*
		 * Exactly the same gate and modal as Uncomment's own selection-
		 * based handling.
		 */
		var useTrailingUncommentROUTC = ! removeTrailingComments;

		if ( removeTrailingComments ) {

			var trailingChoiceROUTC = await askRemoveTrailingComments();

			if ( ! trailingChoiceROUTC ) { return; }

			useTrailingUncommentROUTC = ( trailingChoiceROUTC === 'Uncomment' );

		}

		var rangeTextROUTC = wholeDocTextROUTC.slice( rangeStartOffsetROUTC, rangeEndOffsetROUTC );

		var relativeTrailingSegments = scopedTrailingSegments.map( function( seg ) {
			return {
				start:				seg.start - rangeStartOffsetROUTC,
				end:				seg.end - rangeStartOffsetROUTC,
				styleKey:			seg.styleKey,
				isTrailingComment:	true
			};
		} );

		var newRangeTextROUTC	= applySegmentEdits( rangeTextROUTC, relativeTrailingSegments, useTrailingUncommentROUTC );
		var replaceRangeROUTC	= new vscode.Range( document.positionAt( rangeStartOffsetROUTC ), document.positionAt( rangeEndOffsetROUTC ) );

		await editor.edit( function( editBuilder ) { editBuilder.replace( replaceRangeROUTC, newRangeTextROUTC ); } );

		var selectionStartPosROUTC = document.positionAt( rangeStartOffsetROUTC );
		var selectionEndPosROUTC = document.positionAt( rangeStartOffsetROUTC + newRangeTextROUTC.length );
		finishSelection( selectionStartPosROUTC, selectionEndPosROUTC );

		var trailingCountNoun	= ( scopedTrailingSegments.length === 1 ) ? 'trailing comment' : 'trailing comments',
			trailingVerb		= useTrailingUncommentROUTC ? 'uncommented' : 'removed',
			trailingMessage		= scriptPrefix + scopedTrailingSegments.length + ' ' + trailingCountNoun + ' ' + trailingVerb + '.';

		await finish( trailingMessage );

		return;

	}


	var style = COMMENT_STYLES[ action ];

	if ( ! style ) {
		await showErrorModal( scriptPrefix + 'Unknown comment style.' );
		return;
	}

	/*
	 * Cursor-only (no selection) classification against any existing
	 * marker-based comment at this position — see classifyCursorPosition()'s
	 * own comment for the three outcomes. Only applies when nothing is
	 * selected; an explicit selection's intent is already unambiguous.
	 */
	if ( selection.isEmpty ) {

		var classification = classifyCursorPosition( allLines, startLine, selection.active.character, allowedStyleKeys, strictDetection );

		if ( classification.type === 'inside' ) {

			/*
			 * Comment hierarchy: a single-line request never supersedes
			 * something with real markers (level 1 vs. an existing level 2
			 * or 3) — always an error. A marker-based request supersedes an
			 * existing level-2 comment, but not an existing level-3
			 * (JSDoc) one, since nothing casually overrides the top of the
			 * hierarchy — unless the requested style is that same JSDoc
			 * comment, which is the ordinary same-style toggle-off case
			 * and falls through below like any other "existing" match.
			 */
			var existingLevel	= commentLevel( classification.existing.style );
			var requestedLevel	= commentLevel( style );
			var topLevelBlocked	= existingLevel === 3 && classification.existing.key !== action;

			if ( requestedLevel === 1 || topLevelBlocked ) {
				await showErrorModal( scriptPrefix + 'Cursor is inside an existing comment.' );
				return;
			}

			/* Otherwise fall through — the detectExistingComment() call
			 * below will find this same comment and correctly convert or
			 * toggle it off, exactly like the 'unrelated' case does. */

		} else if ( classification.type === 'boundary' ) {

			await insertAdjacentComment( classification.edge, classification.existing, style );
			return;

		}

	}

	/*
	 * Every commenting command first checks for any existing comment
	 * overlapping the target, letting e.g. running JSDoc on an existing
	 * single-line comment convert it rather than wrapping the // marker
	 * inside the new one. No existing comment: add fresh. Same style:
	 * silently do nothing (that's what Uncomment is for). Different
	 * style: remove it first, then apply the requested one — a direct
	 * conversion in one step.
	 */
	var existing = detectExistingComment( allLines, startLine, endLine, allowedStyleKeys, strictDetection );

	if ( existing && existing.key === action ) {

		return;

	} else if ( existing ) {

		var cleanedLines	= removeComment( allLines, existing.startLine, existing.endLine, existing.style );
		var baseIndent		= normaliseWhitespace( getLeadingWhitespace( cleanedLines[0] || '' ) );

		var convertedLines = addComment( cleanedLines, style, baseIndent, strictDetection );
		var addedCount		= countAddedComments( cleanedLines, convertedLines, style );

		await replaceLines( existing.startLine, existing.endLine, convertedLines );
		await finish( scriptPrefix + addedCount + ' ' + ( addedCount === 1 ? 'comment' : 'comments' ) + ' added.' );

	} else {

		var targetLines		= allLines.slice( startLine, endLine + 1 );
		var preStrippedLines	= stripMixedLineComments( targetLines, allowedStyleKeys, action, strictDetection );
		var freshIndent		= normaliseWhitespace( getLeadingWhitespace( preStrippedLines[0] || '' ) );

		var freshLines = addComment( preStrippedLines, style, freshIndent, strictDetection );
		var addedCount = countAddedComments( preStrippedLines, freshLines, style );

		/*
		 * A fresh comment on a single blank line with nothing selected is
		 * the "about to type into it" case — block lands mid-content,
		 * inline lands right after the opening space, rather than either
		 * one's default end-of-result position.
		 */
		var freshOverride = null;

		if ( selection.isEmpty && targetLines.length === 1 && targetLines[0].trim() === '' ) {

			if ( style.kind === 'block' ) {
				freshOverride = { line: 1, character: freshLines[1].length };
			} else if ( style.kind === 'inline' ) {
				freshOverride = { line: 0, character: ( freshIndent + style.open + ' ' ).length };
			}

		}

		await replaceLines( startLine, endLine, freshLines, freshOverride );
		await finish( scriptPrefix + addedCount + ' ' + ( addedCount === 1 ? 'comment' : 'comments' ) + ' added.' );

	}

}

/**
 * Registers one command per comment style, plus the bare default and
 * the two non-style actions (Uncomment, Remove or Uncomment Trailing
 * Comments). Every command ID matches package.json's own
 * contributes.commands exactly.
 */
function activate( context ) {

	context.subscriptions.push(
		vscode.commands.registerCommand( 'smarterComments.default', function() {
			runCommand( null );
		} )
	);

	Object.keys( COMMENT_STYLES ).forEach( function( styleKey ) {
		context.subscriptions.push(
			vscode.commands.registerCommand( 'smarterComments.' + styleKey, function() {
				runCommand( styleKey );
			} )
		);
	} );

	context.subscriptions.push(
		vscode.commands.registerCommand( 'smarterComments.uncomment', function() {
			runCommand( 'uncomment' );
		} )
	);

	context.subscriptions.push(
		vscode.commands.registerCommand( 'smarterComments.removeOrUncommentTrailingComments', function() {
			runCommand( 'remove-or-uncomment-trailing-comments' );
		} )
	);

}

function deactivate() {}

module.exports = {
	activate,
	deactivate
};

/*
	===============================================================
	========================== FUNCTIONS ==========================
	===============================================================
*/

function escapeRegExp( str ) {
	return str.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
}

function getLeadingWhitespace( line ) {
	var m = line.match( /^[ \t]*/ );
	return m ? m[0] : '';
}

function stripLeadingWhitespace( line ) {
	return line.replace( /^[ \t]*/, '' );
}

/**
 * Strips a leading (or trailing, if fromEnd) run of repeated edgeChar
 * characters — decoration layered on top of a comment marker, e.g. the
 * extra asterisks in "*** text" after the base "/*" is already removed.
 * Also consumes further, whitespace-separated repeats of the same
 * decoration (e.g. "### ### ## text"), via a lookahead that only
 * commits if a genuine further run actually follows — ordinary content
 * starting with a single edgeChar after whitespace is left untouched.
 */
function stripDecoration( text, edgeChar, fromEnd ) {

	if ( ! fromEnd ) {

		var i = 0;

		while ( i < text.length && text[i] === edgeChar ) {

			while ( i < text.length && text[i] === edgeChar ) { i++; }

			var afterRun = i;

			while ( afterRun < text.length && /[ \t]/.test( text[ afterRun ] ) ) { afterRun++; }

			if ( afterRun < text.length && text[ afterRun ] === edgeChar ) {
				i = afterRun;
			} else {
				break;
			}

		}

		return text.slice( i );

	}

	var j = text.length;

	while ( j > 0 && text[ j - 1 ] === edgeChar ) {

		while ( j > 0 && text[ j - 1 ] === edgeChar ) { j--; }

		var beforeRun = j;

		while ( beforeRun > 0 && /[ \t]/.test( text[ beforeRun - 1 ] ) ) { beforeRun--; }

		if ( beforeRun > 0 && text[ beforeRun - 1 ] === edgeChar ) {
			j = beforeRun;
		} else {
			break;
		}

	}

	return text.slice( 0, j );

}

/**
 * Normalises a leading-whitespace string per normaliseLeadingWhitespace's
 * own three states: 'tabs' converts every run of spaces to
 * Math.ceil(spaces/SPACES_PER_TAB) tabs, matching codesweeper.js's own
 * approach, existing tabs passing through unchanged; 'spaces' is the
 * genuine mirror — every tab expands to SPACES_PER_TAB spaces, existing
 * spaces passing through unchanged; anything falsy (the default, empty-
 * string "leave as-is") is a no-op, returning whitespace exactly as
 * given.
 */
function normaliseWhitespace( whitespace ) {

	if ( normaliseLeadingWhitespace === 'tabs' ) {

		var tabCount	= 0;
		var i				= 0;

		while ( i < whitespace.length ) {
			if ( whitespace[i] === '\t' ) {
				tabCount++;
				i++;
			} else {
				var spaceRun = 0;
				while ( i < whitespace.length && whitespace[i] === ' ' ) { spaceRun++; i++; }
				tabCount += Math.ceil( spaceRun / SPACES_PER_TAB );
			}
		}

		return '\t'.repeat( tabCount );

	}

	if ( normaliseLeadingWhitespace === 'spaces' ) {

		var spaceCount	= 0;
		var j				= 0;

		while ( j < whitespace.length ) {
			if ( whitespace[j] === ' ' ) {
				spaceCount++;
				j++;
			} else if ( whitespace[j] === '\t' ) {
				spaceCount += SPACES_PER_TAB;
				j++;
			} else {
				j++;
			}
		}

		return ' '.repeat( spaceCount );

	}

	return whitespace;

}

/**
 * Converts a whitespace string to a single numeric scale — a tab counts
 * as SPACES_PER_TAB units, a space as one — so two indents built from
 * genuinely different tab/space mixtures can still be compared
 * meaningfully. Used only by computeRelativeIndent()'s own fallback path,
 * for exactly the case normaliseWhitespace() alone can't resolve: two
 * strings that don't share a literal prefix at all.
 */
function whitespaceToUnits( whitespace ) {
	var units = 0;
	for ( var i = 0; i < whitespace.length; i++ ) {
		units += ( whitespace[i] === '\t' ) ? SPACES_PER_TAB : 1;
	}
	return units;
}

/**
 * Computes how much further indented rawIndent is than baseIndent — the
 * piece of a line's own indentation that belongs to it specifically.
 * Shared by every place that needs to preserve relative depth between
 * lines while respecting normaliseLeadingWhitespace: JSDoc's per-line
 * offset after "* ", and a plain block-wrap comment's content lines.
 *
 * Tries a literal prefix match first (lossless, and the only case that
 * matters when normaliseLeadingWhitespace is 'tabs' or 'spaces', since
 * every normalised indent is then a homogeneous run of one character).
 * Falls back to a best-effort numeric approximation — converting both
 * sides to SPACES_PER_TAB-based units and rendering the difference as
 * tabs — only when the indents share no literal prefix at all, which
 * can happen when normalisation is off and two genuinely incompatible
 * tab/space mixtures are compared directly.
 */
function computeRelativeIndent( rawIndent, baseIndent ) {

	var comparisonIndent = normaliseWhitespace( rawIndent );

	if ( comparisonIndent.indexOf( baseIndent ) === 0 ) {
		return comparisonIndent.slice( baseIndent.length );
	}

	var lineUnits	= whitespaceToUnits( comparisonIndent );
	var baseUnits	= whitespaceToUnits( baseIndent );
	var extraUnits	= Math.max( 0, lineUnits - baseUnits );

	return '\t'.repeat( Math.ceil( extraUnits / SPACES_PER_TAB ) );

}

/* ────────────────────────── block style ────────────────────────── */

/**
 * Applies a 'block' style to an array of (already-selected) lines, returning
 * the new array of lines to replace them with. See COMMENT_STYLES' own
 * comment for the linePrefix (JSDoc) vs no-linePrefix (plain block-wrap)
 * distinction.
 *
 * Both branches now respect normaliseLeadingWhitespace per line, via
 * computeRelativeIndent() — genuinely new, not just restoring what used
 * to be there: content here was always being handled as one whole block
 * before, either uniformly flattened (linePrefix) or left completely
 * untouched (plain wrap), neither of which had any per-line indent
 * concept to normalise in the first place. baseIndent itself arrives
 * already normalised, from addComment()'s own caller.
 */
function applyBlockComment( lines, style, baseIndent ) {

	var openLine	= baseIndent + style.open;
	var closeLine	= baseIndent + ( style.linePrefix ? ' ' : '' ) + style.close;

	if ( style.linePrefix ) {

		var body = lines.map( function( line ) {
			var rawIndent	= getLeadingWhitespace( line );
			var content		= line.slice( rawIndent.length );
			var relative	= computeRelativeIndent( rawIndent, baseIndent );
			return baseIndent + ' ' + style.linePrefix + ' ' + relative + content;
		} );

		return [ openLine ].concat( body ).concat( [ closeLine ] );

	}

	var plainBody = lines.map( function( line ) {
		if ( line.trim() === '' ) { return line; }
		var rawIndent	= getLeadingWhitespace( line );
		var content		= line.slice( rawIndent.length );
		var relative	= computeRelativeIndent( rawIndent, baseIndent );
		return baseIndent + relative + content;
	} );

	return [ openLine ].concat( plainBody ).concat( [ closeLine ] );

}

/**
 * True if the trimmed line starts with this style's open marker — not
 * necessarily bare on its own line.
 */
function isBlockCommentOpenLine( line, style ) {
	return line.trim().indexOf( style.open ) === 0;
}

/**
 * True if the trimmed line ends with this style's close marker — not
 * necessarily bare on its own line.
 */
function isBlockCommentCloseLine( line, style ) {
	var trimmed = line.trim();
	return trimmed.length >= style.close.length &&
		trimmed.lastIndexOf( style.close ) === trimmed.length - style.close.length;
}

/**
 * Searches for this style's comment overlapping [startLine, endLine], in
 * any of the ways a selection and an existing comment can relate: fully
 * inside, fully containing, or a partial overlap at either end. Searches
 * backward from endLine for the nearest open marker, then forward for
 * its close, then confirms the found comment actually overlaps the
 * selection. Returns { startLine, endLine } or null. Also used for
 * 'inline'-kind styles via findEnclosingComment() — the marker-matching
 * here is identical in shape for both kinds.
 */
function findEnclosingBlockComment( allLines, startLine, endLine, style ) {

	var openAt = -1;
	for ( var i = endLine; i >= 0; i-- ) {
		if ( isBlockCommentOpenLine( allLines[i], style ) ) { openAt = i; break; }
	}
	if ( openAt === -1 ) { return null; }

	/*
	 * Self-contained single line: the open line is long enough to hold
	 * both markers and also ends with the close marker. Checked before
	 * searching later lines for a separate close, and must pass the same
	 * overlap check as the multi-line path below.
	 */
	var openTrimmed = allLines[ openAt ].trim();
	if ( openTrimmed.length >= style.open.length + style.close.length &&
			isBlockCommentCloseLine( allLines[ openAt ], style ) ) {

		if ( openAt < startLine ) { return null; }
		return { startLine: openAt, endLine: openAt };

	}

	var closeAt = -1;
	for ( var j = openAt + 1; j < allLines.length; j++ ) {
		if ( isBlockCommentCloseLine( allLines[j], style ) ) { closeAt = j; break; }
	}
	if ( closeAt === -1 ) { return null; }

	if ( closeAt < startLine ) { return null; }

	return { startLine: openAt, endLine: closeAt };

}

function isCommentedBlock( allLines, startLine, endLine, style ) {
	return findEnclosingBlockComment( allLines, startLine, endLine, style ) !== null;
}

/**
 * True if every non-blank line in body starts with the JSDoc-style "* "
 * prefix (or is exactly "*") — checked on a comment that isn't formally
 * JSDoc, so removeBlockComment() can still strip it the same way on
 * removal. Requires every non-blank line to match, not just most, since
 * one genuinely unrelated line starting with "*" should leave the whole
 * comment's content untouched rather than guess which lines are real
 * decoration.
 */
function isJSDocShapedBody( body ) {

	if ( body.length === 0 ) { return false; }

	return body.every( function( line ) {
		var trimmed = line.trim();
		return trimmed === '' || trimmed === '*' || trimmed.indexOf( '* ' ) === 0;
	} );

}

/**
 * Removes a block comment given its already-located boundaries
 * (startLine = open-marker line, endLine = close-marker line). For
 * linePrefix styles (JSDoc): strips only the " * " portion, restoring
 * baseIndent + content per line — exact only when every line shared the
 * same indentation to begin with, since applyBlockComment() already
 * discarded any per-line indentation beyond the first when flattening.
 * A plain C Multiline block whose body is JSDoc-shaped anyway (see
 * isJSDocShapedBody()) gets the same treatment. For plain block-wrap
 * styles: content sharing the open/close line with the marker must
 * survive removal, and any decorative marker repeats (stripDecoration())
 * are stripped too. The single-line (collapsed) case is handled
 * uniformly regardless of linePrefix.
 */
function removeBlockComment( allLines, startLine, endLine, style ) {

	if ( startLine === endLine ) {

		var soloLine	= allLines[ startLine ];
		var soloIndent	= getLeadingWhitespace( soloLine );
		var inner		= soloLine.slice( soloIndent.length + style.open.length );

		inner = stripDecoration( inner, style.open[ style.open.length - 1 ], false ).replace( /^ /, '' );
		inner = inner.slice( 0, inner.length - style.close.length );
		inner = stripDecoration( inner, style.close[0], true ).replace( / $/, '' );

		return [ soloIndent + inner ];

	}

	var jsdocShapedFallback = ( ! style.linePrefix ) && style.open === '/*' && isJSDocShapedBody( allLines.slice( startLine + 1, endLine ) );

	if ( style.linePrefix || jsdocShapedFallback ) {

		var body		= allLines.slice( startLine + 1, endLine );
		var baseIndent	= getLeadingWhitespace( allLines[ startLine ] );
		var linePrefix	= style.linePrefix || '*';
		var re			= new RegExp( '^' + escapeRegExp( baseIndent ) + ' ' + escapeRegExp( linePrefix ) + ' ?' );

		var resultLines = body.map( function( line ) { return line.replace( re, baseIndent ); } );

		/*
		 * Content may share the close line with the marker itself — e.g.
		 * a comment whose last content line ends with the closing "*"+"/"
		 * pair right after it — and must not be silently discarded just
		 * because it isn't strictly between the open and close lines.
		 * Strips the same body-line prefix pattern from the raw close
		 * line first (consistent with how every other line is handled),
		 * then extracts whatever's left before the close marker, then
		 * also runs that through the same decoration-stripping the
		 * plain-wrap branch below already uses, so a decorated close
		 * (extra asterisks before the final slash) doesn't leak into the
		 * result either.
		 */
		var closeLine			= allLines[ endLine ];
		var closeLineStripped	= closeLine.replace( re, baseIndent );
		var beforeClose			= closeLineStripped.slice( baseIndent.length, closeLineStripped.length - style.close.length );

		beforeClose = stripDecoration( beforeClose, style.close[0], true ).replace( / $/, '' );

		if ( beforeClose !== '' ) { resultLines.push( baseIndent + beforeClose ); }

		return resultLines;

	}

	var resultLines = [];

	var openLine	= allLines[ startLine ];
	var openIndent	= getLeadingWhitespace( openLine );
	var afterOpen	= openLine.slice( openIndent.length + style.open.length );

	afterOpen = stripDecoration( afterOpen, style.open[ style.open.length - 1 ], false ).replace( /^ /, '' );

	if ( afterOpen !== '' ) { resultLines.push( openIndent + afterOpen ); }

	for ( var k = startLine + 1; k < endLine; k++ ) { resultLines.push( allLines[k] ); }

	var closeLine		= allLines[ endLine ];
	var closeIndent	= getLeadingWhitespace( closeLine );
	var closeBody		= closeLine.slice( closeIndent.length );
	var beforeClose	= closeBody.slice( 0, closeBody.length - style.close.length );

	beforeClose = stripDecoration( beforeClose, style.close[0], true ).replace( / $/, '' );

	if ( beforeClose !== '' ) { resultLines.push( closeIndent + beforeClose ); }

	return resultLines;

}

/* ─────────────────────────── line style ────────────────────────── */

/**
 * Applies a 'line' style to an array of lines — each line keeps its own
 * leading whitespace, with the prefix + single space inserted right
 * after it. A blank line still gets the trailing space, ready for
 * immediate typing — unless the target spans more than one line, where
 * blank lines are left untouched instead (controlled by
 * skipBlankLinesInMultiline). A non-blank line already commented with
 * this same style is also left untouched, checked per line so a mixed-
 * state multi-line selection doesn't double up the prefix on lines that
 * already had one. Each line's own indent is normalised individually,
 * not flattened to one shared value the way a block comment's is.
 */
function applyLineComment( lines, style, strict ) {

	var skipBlanks = skipBlankLinesInMultiline && lines.length > 1;

	return lines.map( function( line ) {
		if ( skipBlanks && line.trim() === '' ) { return line; }
		if ( line.trim() !== '' && isLineCommentedLine( line, style, strict ) ) { return line; }
		var rawIndent	= getLeadingWhitespace( line );
		var content		= line.slice( rawIndent.length );
		var indent		= normaliseWhitespace( rawIndent );
		return indent + style.prefix + ' ' + content;
	} );

}

/**
 * True if this line is genuinely a line comment in this style. When
 * strict, requires that after the marker and any decoration are
 * stripped, what remains is empty or starts with a space — distinguishing
 * a real comment from something that merely starts with the marker by
 * coincidence (a CSS custom property like "--hue-blue-twitter"). strict
 * is true only for a language known to embed riskier ones (html), not
 * simply the inverse of an allowedKeys restriction. The other defence
 * against a coincidental collision (SQL's "--", VB's "'") is nativeOnly,
 * keeping a style out of the candidate list for the wrong language
 * entirely rather than catching it here on shape alone.
 */
function isLineCommentedLine( line, style, strict ) {

	if ( line.trim() === '' ) { return true; }	/* blank lines don't disqualify a range */

	var trimmed = stripLeadingWhitespace( line );
	if ( trimmed.indexOf( style.prefix ) !== 0 ) { return false; }

	if ( ! strict ) { return true; }

	var edgeChar	= style.prefix[ style.prefix.length - 1 ];
	var rest		= stripDecoration( trimmed.slice( style.prefix.length ), edgeChar, false );

	return rest === '' || rest[0] === ' ';

}

/**
 * True if every line in [startLine, endLine] is blank or prefixed with
 * this style, and at least one line is non-blank.
 */
function isCommentedLine( allLines, startLine, endLine, style, strict ) {

	for ( var i = startLine; i <= endLine; i++ ) {
		if ( ! isLineCommentedLine( allLines[i], style, strict ) ) { return false; }
	}

	return allLines.slice( startLine, endLine + 1 ).some( function( l ) { return l.trim() !== ''; } );

}

/**
 * Verifies [startLine, endLine] is entirely commented — never expands
 * beyond what was targeted, unlike a block comment. Returns { startLine,
 * endLine } unchanged, or null.
 */
function findEnclosingLineComment( allLines, startLine, endLine, style, strict ) {

	if ( ! isCommentedLine( allLines, startLine, endLine, style, strict ) ) { return null; }

	return { startLine: startLine, endLine: endLine };

}

/**
 * Strips a single line's own line-style comment marker — the base
 * prefix, then any decorative repeats of its edge character. Caller's
 * responsibility to skip blank lines first. Factored out so
 * removeLineComment() and stripMixedLineComments() share one, consistent
 * stripping behaviour.
 */
function stripLineCommentPrefix( line, style ) {

	var edgeChar		= style.prefix[ style.prefix.length - 1 ];
	var rawIndent		= getLeadingWhitespace( line );
	var rest				= line.slice( rawIndent.length + style.prefix.length );

	rest = stripDecoration( rest, edgeChar, false ).replace( /^ /, '' );

	return normaliseWhitespace( rawIndent ) + rest;

}

/**
 * Removes a line comment from every line in [startLine, endLine]. Blank
 * lines are left untouched.
 */
function removeLineComment( allLines, startLine, endLine, style ) {

	return allLines.slice( startLine, endLine + 1 ).map( function( line ) {

		if ( line.trim() === '' ) { return line; }

		return stripLineCommentPrefix( line, style );

	} );

}

/**
 * Pre-processing for the fresh-add path: detectExistingComment() only
 * recognises a single comment spanning the whole target, so a mixed-
 * state multi-line selection (some lines commented, others not) falls
 * through to "nothing's commented here" — without this, an existing
 * marker would be wrapped as literal content in the new comment rather
 * than stripped first. For each line, strips the first OTHER allowed
 * line-kind style that matches (never targetStyleKey itself, which
 * applyLineComment()'s own same-style check already handles). Scoped to
 * line-kind existing comments only.
 */
function stripMixedLineComments( lines, allowedStyleKeys, targetStyleKey, strict ) {

	var candidateStyles = ( allowedStyleKeys || DETECTION_ORDER )
		.filter( function( key ) { return key !== targetStyleKey; } )
		.filter( function( key ) { return COMMENT_STYLES[ key ].kind === 'line'; } )
		.map( function( key ) { return COMMENT_STYLES[ key ]; } );

	return lines.map( function( line ) {

		if ( line.trim() === '' ) { return line; }

		var matchedStyle = candidateStyles.filter( function( candidate ) {
			return isLineCommentedLine( line, candidate, strict );
		} )[0];

		return matchedStyle ? stripLineCommentPrefix( line, matchedStyle ) : line;

	} );

}

/* ───────────────────────── inline style ─────────────────────────── */

/**
 * Wraps target lines with open+space at the very start and space+close
 * at the very end — a single wrap around the joined text as one string,
 * not per line. baseIndent becomes the prefix ahead of the open marker;
 * each line's own leading whitespace is stripped before joining, so the
 * indent isn't duplicated inside the wrap.
 */
function applyInlineComment( lines, style, baseIndent ) {

	var strippedText = lines.map( stripLeadingWhitespace ).join( '\n' );

	return baseIndent + style.open + ' ' + strippedText + ' ' + style.close;

}

function isCommentedInline( text, style ) {
	var trimmed = text.trim();
	return trimmed.indexOf( style.open ) === 0 &&
		trimmed.lastIndexOf( style.close ) === trimmed.length - style.close.length;
}

/**
 * Reverses applyInlineComment() — restores the leading whitespace ahead
 * of the unwrapped content, so a comment round-trips back to exactly the
 * indent it was added with. Also strips decorative repeats of the
 * open/close markers' own edge characters.
 */
function removeInlineComment( text, style ) {

	var indent	= normaliseWhitespace( getLeadingWhitespace( text ) );
	var trimmed	= text.trim();
	var inner	= trimmed.slice( style.open.length, trimmed.length - style.close.length );

	inner = stripDecoration( inner, style.open[ style.open.length - 1 ], false ).replace( /^ /, '' );
	inner = stripDecoration( inner, style.close[0], true ).replace( / $/, '' );

	return indent + inner;

}

/* ─────────────────────── style-agnostic dispatch ────────────────────── */

function isCommentedWithStyle( allLines, startLine, endLine, style, strict ) {

	if ( style.kind === 'block' )	{ return isCommentedBlock( allLines, startLine, endLine, style ); }
	if ( style.kind === 'line' )	{ return isCommentedLine( allLines, startLine, endLine, style, strict ); }

	if ( style.kind === 'inline' ) {
		var text = allLines.slice( startLine, endLine + 1 ).join( '\n' );
		return isCommentedInline( text, style );
	}

	return false;

}

/**
 * inline-kind styles use the same open/close marker search as block-kind,
 * but a match is only valid when genuinely self-contained on one line —
 * resolving which style a collapsed one-liner belongs to. A non-self-
 * contained match is rejected here, letting the matching multiline-kind
 * style take it instead.
 */
function findEnclosingComment( allLines, startLine, endLine, style, strict ) {

	if ( style.kind === 'block' ) { return findEnclosingBlockComment( allLines, startLine, endLine, style ); }

	if ( style.kind === 'inline' ) {

		var found = findEnclosingBlockComment( allLines, startLine, endLine, style );

		if ( found && found.startLine !== found.endLine ) { return null; }

		return found;

	}

	if ( style.kind === 'line' ) { return findEnclosingLineComment( allLines, startLine, endLine, style, strict ); }

	return null;

}

/**
 * Detection order for detectExistingComment() — COMMENT_STYLES' own
 * declaration order, with every line-kind style moved after every
 * block/inline-kind one. This matters because a line-kind marker can be
 * a literal prefix of a block/inline one ("-->" starts with "--"), and a
 * block/inline match is the stronger claim, requiring both an open and
 * close marker actually found, not just a coincidental prefix.
 */
var DETECTION_ORDER = Object.keys( COMMENT_STYLES ).filter( function( key ) {
	return COMMENT_STYLES[ key ].kind !== 'line';
} ).concat( Object.keys( COMMENT_STYLES ).filter( function( key ) {
	return COMMENT_STYLES[ key ].kind === 'line';
} ) );

/**
 * Tries every style in DETECTION_ORDER, returning the first whose
 * boundaries can be found enclosing [startLine, endLine]. Used by every
 * command's implicit "what's already here" check. Returns { key, style,
 * startLine, endLine } or null. allowedKeys restricts detection to
 * styles valid for the file type; strict is a separate parameter, not
 * derived from allowedKeys, since a language missing from that table
 * could mean either "genuinely unknown" (false) or "known to embed other
 * languages" (true — html).
 */
function detectExistingComment( allLines, startLine, endLine, allowedKeys, strict ) {

	for ( var i = 0; i < DETECTION_ORDER.length; i++ ) {

		var key = DETECTION_ORDER[ i ];

		if ( allowedKeys && allowedKeys.indexOf( key ) === -1 ) { continue; }

		var style = COMMENT_STYLES[ key ];
		var found = findEnclosingComment( allLines, startLine, endLine, style, strict );

		if ( found && isCommentedWithStyle( allLines, found.startLine, found.endLine, style, strict ) ) {
			return { key: key, style: style, startLine: found.startLine, endLine: found.endLine };
		}

	}

	return null;

}

/**
 * Scans a single line for every self-contained marker-based comment on
 * it — an open whose matching close also occurs on this same line.
 * Returns null the moment a genuinely unclosed open is found. Returns an
 * array of { startIndex, endIndex, style } otherwise, left to right.
 * Quote-tracking matters here since HTML attribute values are full of
 * quote characters, and a marker-shaped sequence inside one shouldn't be
 * read as a real comment marker.
 */
function findSelfContainedCommentsOnLine( line, markerKeys ) {

	var markerStyles = markerKeys
		.map( function( key ) { return COMMENT_STYLES[ key ]; } )
		.sort( function( a, b ) { return b.open.length - a.open.length; } );

	var matches	= [];
	var inQuote	= null;
	var i			= 0;

	while ( i < line.length ) {

		var ch = line[i];

		if ( inQuote ) {
			if ( ch === '\\' ) { i += 2; continue; }
			if ( ch === inQuote ) { inQuote = null; }
			i++;
			continue;
		}

		if ( ch === '"' || ch === '\'' ) { inQuote = ch; i++; continue; }

		var openedStyle = markerStyles.filter( function( style ) {
			return line.slice( i, i + style.open.length ) === style.open;
		} )[0];

		if ( ! openedStyle ) { i++; continue; }

		var closeAt = line.indexOf( openedStyle.close, i + openedStyle.open.length );

		if ( closeAt === -1 ) { return null; }

		matches.push( {
			startIndex:	i,
			endIndex:	closeAt + openedStyle.close.length,
			style:		openedStyle
		} );

		i = closeAt + openedStyle.close.length;

	}

	return matches;

}

/**
 * The functions in this section, through tokenizeComments(), model
 * comment detection as a single-pass scan across the whole target text,
 * the way a browser's own parser would — this is what both Uncomment and
 * Remove or Uncomment Trailing Comments actually run on.
 *
 * Finds every region of text genuinely enclosed in a quote character — a
 * ' or " opened and later closed by a matching, unescaped occurrence of
 * the same character, honouring \ escapes. quoteChars must be combined
 * into one regex alternation, not run as separate passes — this is what
 * makes an apostrophe inside a double-quoted string (e.g. "Can't do
 * that") correctly read as ordinary content, since regex alternation
 * commits to the earliest, leftmost match.
 *
 * Never lets a quote pairing cross a line break — an ordinary unescaped
 * apostrophe (a genuine contraction inside a "//" comment) would
 * otherwise keep searching forward across the rest of the document for
 * the next unrelated apostrophe, misreading everything in between as
 * inside a quoted string.
 */
function findQuotedRegions( text, quoteChars ) {

	var parts = quoteChars.map( function( q ) {
		var esc = escapeRegExp( q );
		return esc + '(?:[^' + esc + '\\\\\n]|\\\\.)*' + esc;
	} );

	var pattern	= new RegExp( parts.join( '|' ), 'g' );
	var regions	= [];
	var m;

	while ( ( m = pattern.exec( text ) ) !== null ) {
		regions.push( { start: m.index, end: m.index + m[0].length } );
	}

	return regions;

}

function isWithinAnyRegion( pos, regions ) {
	return regions.some( function( r ) { return pos >= r.start && pos < r.end; } );
}

/**
 * Groups marker-based styles among allowedKeys by their shared close
 * marker (jsdoc, c-multiline-inline, and c-multiline-block all close on
 * the same sequence) — one "family" scan is built against this, with
 * sub-style classification happening afterward.
 */
function groupMarkerFamiliesByClose( allowedKeys ) {

	var families = {};

	allowedKeys.forEach( function( key ) {

		var style = COMMENT_STYLES[ key ];

		if ( style.kind !== 'block' && style.kind !== 'inline' ) { return; }

		if ( ! families[ style.close ] ) { families[ style.close ] = []; }

		families[ style.close ].push( key );

	} );

	return Object.keys( families ).map( function( close ) {
		return { close: close, keys: families[ close ] };
	} );

}

/**
 * Given a marker-family span's raw captured text and the candidate keys
 * sharing that family's close marker, determines which specific style it
 * is (e.g. jsdoc vs c-multiline-inline/block, which all share one close).
 * Checks which open it started with (longest-first, so jsdoc's "/**" is
 * recognised ahead of plain c-multiline's shorter "/*"), then among
 * styles sharing that open, which kind (inline vs block) matches the
 * span's actual shape (does it contain a newline). Returns the matching
 * key, or null if the open isn't a real candidate at all.
 */
function classifyMarkerSpan( raw, candidateKeys ) {

	var isMultiLine = raw.indexOf( '\n' ) !== -1;

	var byOpenLengthDesc = candidateKeys.slice().sort( function( a, b ) {
		return COMMENT_STYLES[ b ].open.length - COMMENT_STYLES[ a ].open.length;
	} );

	var openMatch = byOpenLengthDesc.filter( function( key ) {
		return raw.indexOf( COMMENT_STYLES[ key ].open ) === 0;
	} )[0];

	if ( ! openMatch ) { return null; }

	var matchedOpen = COMMENT_STYLES[ openMatch ].open;

	var sameOpenKeys = candidateKeys.filter( function( key ) {
		return COMMENT_STYLES[ key ].open === matchedOpen;
	} );

	var kindMatch = sameOpenKeys.filter( function( key ) {
		var wantsBlock = COMMENT_STYLES[ key ].kind === 'block';
		return wantsBlock === isMultiLine;
	} )[0];

	return kindMatch || sameOpenKeys[0];

}

/**
 * Finds every comment in text, across every style in allowedKeys, in a
 * single, unified left-to-right pass. Returns segments in ascending
 * start order: { start, end, styleKey, isTrailingComment }.
 *
 * Core principle: collect every candidate comment start — both marker-
 * family opens and line-kind prefixes — into one combined, position-
 * sorted list, then process strictly left-to-right. Whichever candidate
 * is earliest wins, claims its own full extent, and any other candidate
 * whose start falls within that claimed extent is simply never reached.
 * This single mechanism handles several distinct interaction risks:
 * two marker families abutting or nested-looking, one family's content
 * containing another's marker shape, a line-kind comment resembling a
 * marker-family open with an unrelated close appearing much later.
 *
 * Quote-awareness excludes any candidate start falling inside a genuine
 * quoted string before it's even considered — a quoted-but-marker-shaped
 * sequence was never a real candidate at all. A marker-family open with
 * no matching close anywhere in the remaining text is simply skipped.
 *
 * isTrailingComment: true only when real, non-whitespace content
 * precedes the marker on its own line. A marker-family match gets the
 * same treatment, but only when collapsed to a single line, and never
 * for HTML's own two styles — HTML comments conventionally label a
 * closing tag from a distance, a role no other trailing-comment
 * convention shares.
 */
function tokenizeComments( text, allowedKeys, quoteChars ) {

	var quotedRegions		= findQuotedRegions( text, quoteChars );
	var markerFamilies	= groupMarkerFamiliesByClose( allowedKeys );
	var lineKeys			= allowedKeys.filter( function( key ) { return COMMENT_STYLES[ key ].kind === 'line'; } );

	var candidates = [];

	markerFamilies.forEach( function( family ) {

		var searchFrom = 0;

		while ( true ) {

			var idx = -1;

			family.keys.forEach( function( key ) {
				var open		= COMMENT_STYLES[ key ].open;
				var openAt	= text.indexOf( open, searchFrom );
				if ( openAt !== -1 && ( idx === -1 || openAt < idx ) ) { idx = openAt; }
			} );

			if ( idx === -1 ) { break; }

			searchFrom = idx + 1;

			if ( isWithinAnyRegion( idx, quotedRegions ) ) { continue; }

			candidates.push( { start: idx, type: 'marker', family: family } );

		}

	} );

	lineKeys.forEach( function( key ) {

		var prefix		= COMMENT_STYLES[ key ].prefix;
		var searchFrom	= 0;

		while ( true ) {

			var idx = text.indexOf( prefix, searchFrom );

			if ( idx === -1 ) { break; }

			searchFrom = idx + 1;

			if ( isWithinAnyRegion( idx, quotedRegions ) ) { continue; }

			var lineStart	= text.lastIndexOf( '\n', idx - 1 ) + 1;
			var before		= text.slice( lineStart, idx );
			var validStart	= before.trim() === '' || /[ \t]/.test( text[ idx - 1 ] || '' );

			if ( ! validStart ) { continue; }

			candidates.push( { start: idx, type: 'line', styleKey: key } );

		}

	} );

	candidates.sort( function( a, b ) { return a.start - b.start; } );

	var segments	= [];
	var pos			= 0;

	candidates.forEach( function( c ) {

		if ( c.start < pos ) { return; }

		if ( c.type === 'marker' ) {

			var closeAt = text.indexOf( c.family.close, c.start + 1 );

			if ( closeAt === -1 ) { return; }

			var end			= closeAt + c.family.close.length;
			var raw			= text.slice( c.start, end );
			var styleKey	= classifyMarkerSpan( raw, c.family.keys );

			if ( ! styleKey ) { return; }

			var isCollapsed		= raw.indexOf( '\n' ) === -1;
			var isHtmlStyle		= styleKey === 'html-inline' || styleKey === 'html-block';
			var markerIsTrailing = false;

			if ( isCollapsed && ! isHtmlStyle ) {
				var markerLineStart	= text.lastIndexOf( '\n', c.start - 1 ) + 1;
				var markerBefore		= text.slice( markerLineStart, c.start );
				markerIsTrailing		= markerBefore.trim() !== '';
			}

			segments.push( { start: c.start, end: end, styleKey: styleKey, isTrailingComment: markerIsTrailing } );

			pos = end;

		} else {

			var lineEnd		= text.indexOf( '\n', c.start );
			var lineEndPos	= ( lineEnd === -1 ) ? text.length : lineEnd;
			var lineStart2	= text.lastIndexOf( '\n', c.start - 1 ) + 1;
			var before2		= text.slice( lineStart2, c.start );

			segments.push( {
				start:				c.start,
				end:					lineEndPos,
				styleKey:			c.styleKey,
				isTrailingComment:	before2.trim() !== ''
			} );

			pos = lineEndPos;

		}

	} );

	return segments;

}

/**
 * Strips a marker-based comment's own markers from its raw captured text
 * (see tokenizeComments()), returning just its content. Operates
 * directly on the string, never on line-index slices, so content on the
 * close line itself is never structurally excluded.
 *
 * Multi-line case: uses the true base indent preceding the open marker
 * in the real document, passed in as precedingIndent, rather than
 * derived from raw's own first line — raw starts exactly at the marker
 * character, so it never includes whatever indentation precedes it.
 * precedingIndent is only used when it's genuinely just whitespace; if
 * real content precedes the marker on the same line, this falls back to
 * raw's own first line instead.
 *
 * A linePrefix style (JSDoc), or a plain C Multiline comment whose body
 * is JSDoc-shaped anyway, has every middle and close line's " * " prefix
 * stripped back to baseIndent; otherwise content is left untouched line
 * for line. Content sharing the open or close line with the marker
 * itself survives, decoration stripped from whichever edge borders it.
 */
function stripMarkerComment( raw, styleKey, precedingIndent ) {

	var style			= COMMENT_STYLES[ styleKey ];
	var openEdgeChar	= style.open[ style.open.length - 1 ];
	var closeEdgeChar	= style.close[0];

	if ( raw.indexOf( '\n' ) === -1 ) {

		var inner = raw.slice( style.open.length, raw.length - style.close.length );

		inner = stripDecoration( inner, openEdgeChar, false ).replace( /^ /, '' );
		inner = stripDecoration( inner, closeEdgeChar, true ).replace( / $/, '' );

		return ( precedingIndent || '' ) + inner;

	}

	var lines			= raw.split( '\n' );
	var firstLine		= lines[0];
	var lastLine		= lines[ lines.length - 1 ];
	var middleLines	= lines.slice( 1, -1 );
	var baseIndent		= ( precedingIndent != null ) ? precedingIndent : firstLine.match( /^[ \t]*/ )[0];

	var jsdocShaped = !! style.linePrefix;

	if ( ! jsdocShaped && style.open === '/*' ) {
		var closeLineBody = lastLine.slice( 0, lastLine.length - style.close.length );
		jsdocShaped = isJSDocShapedBody( middleLines.concat( [ closeLineBody ] ) );
	}

	var linePrefix		= style.linePrefix || ( jsdocShaped ? '*' : null );
	var resultLines	= [];

	var afterOpen = firstLine.slice( firstLine.match( /^[ \t]*/ )[0].length + style.open.length );
	afterOpen = stripDecoration( afterOpen, openEdgeChar, false ).replace( /^ /, '' );
	if ( afterOpen.trim() !== '' ) { resultLines.push( baseIndent + afterOpen ); }

	middleLines.forEach( function( line ) {
		if ( linePrefix ) {
			/*
			 * Matches any leading whitespace before the prefix character,
			 * not anchored to baseIndent's own literal characters — the
			 * real comment's whitespace here might be a different mix
			 * (e.g. spaces where baseIndent is now tabs).
			 */
			var re = new RegExp( '^[ \\t]*' + escapeRegExp( linePrefix ) + ' ?' );
			resultLines.push( line.replace( re, baseIndent ) );
		} else {
			var lineRawIndent	= getLeadingWhitespace( line );
			var lineContent		= line.slice( lineRawIndent.length );
			var lineRelative		= computeRelativeIndent( lineRawIndent, baseIndent );
			resultLines.push( lineContent.trim() === '' ? line : baseIndent + lineRelative + lineContent );
		}
	} );

	var beforeClose = lastLine.slice( 0, lastLine.length - style.close.length );
	if ( linePrefix ) {
		var closeRe = new RegExp( '^[ \\t]*' + escapeRegExp( linePrefix ) + ' ?' );
		beforeClose = beforeClose.replace( closeRe, baseIndent );
	} else if ( beforeClose.trim() !== '' ) {
		var closeRawIndent	= getLeadingWhitespace( beforeClose );
		var closeContent		= beforeClose.slice( closeRawIndent.length );
		var closeRelative		= computeRelativeIndent( closeRawIndent, baseIndent );
		beforeClose = baseIndent + closeRelative + closeContent;
	}
	beforeClose = stripDecoration( beforeClose, closeEdgeChar, true ).replace( / $/, '' );
	if ( beforeClose.trim() !== '' ) { resultLines.push( beforeClose ); }

	var joined = resultLines.join( '\n' );

	/*
	 * baseIndent stays explicitly present exactly once, at the start —
	 * computeSegmentEdit() widens the edit backward to cover the real
	 * preceding indent, so nothing outside this duplicates it.
	 */

	return joined;

}

/**
 * Given one segment (from tokenizeComments()) and the full text it was
 * found in, computes the actual edit to apply: { start, end, replacement
 * }. A trailing comment's start is extended backward to also consume
 * the separating whitespace, matching "removed in its entirety".
 */
function computeSegmentEdit( text, segment ) {

	if ( segment.isTrailingComment ) {

		var start = segment.start;

		while ( start > 0 && /[ \t]/.test( text[ start - 1 ] ) ) { start--; }

		return { start: start, end: segment.end, replacement: '' };

	}

	var style		= COMMENT_STYLES[ segment.styleKey ];
	var raw			= text.slice( segment.start, segment.end );
	var replacement;
	var editStart	= segment.start;

	/*
	 * Decoration (a repeated run of the marker's own character, e.g.
	 * "###...# text") is stripped the same way stripMarkerComment()
	 * handles a marker-based comment's own open edge: strip the base
	 * prefix, then further repeats of its last character, then one
	 * following space. A line-kind comment has no close side to also
	 * strip — trailing repeats are genuinely just content and are left
	 * untouched.
	 */
	if ( style.kind === 'line' ) {

		var afterPrefix	= raw.slice( style.prefix.length );
		var edgeChar		= style.prefix[ style.prefix.length - 1 ];

		replacement = stripDecoration( afterPrefix, edgeChar, false ).replace( /^ /, '' );

		/*
		 * Widens the edit start backward to also cover the line's own
		 * preceding indent, so it can be normalised too — only when that
		 * preceding text is purely whitespace, since real content sharing
		 * the line shouldn't be misread as indentation.
		 */
		var lineStartForIndent	= text.lastIndexOf( '\n', segment.start - 1 ) + 1;
		var precedingForIndent	= text.slice( lineStartForIndent, segment.start );

		if ( /^[ \t]*$/.test( precedingForIndent ) ) {
			editStart		= lineStartForIndent;
			replacement	= normaliseWhitespace( precedingForIndent ) + replacement;
		}

	} else {

		/*
		 * The true base indent for a marker-based comment is whatever
		 * precedes its open marker on its own line — never derivable from
		 * raw itself, since segment.start points exactly at the marker.
		 * Only used when that preceding text is purely whitespace, and
		 * the edit itself is widened backward to cover it.
		 */
		var lineStart		= text.lastIndexOf( '\n', segment.start - 1 ) + 1;
		var precedingText	= text.slice( lineStart, segment.start );
		var precedingIsWhitespace = /^[ \t]*$/.test( precedingText );
		var precedingIndent	= precedingIsWhitespace ? normaliseWhitespace( precedingText ) : null;

		if ( precedingIsWhitespace ) { editStart = lineStart; }

		replacement = stripMarkerComment( raw, segment.styleKey, precedingIndent );

	}

	return { start: editStart, end: segment.end, replacement: replacement };

}

/**
 * Computes the edit for treating a trailing comment as an ordinary one
 * to uncomment — exposing its content rather than deleting it, while
 * also normalising the gap of whitespace separating it from the real
 * code before it, the same basic per-line treatment leading indent gets
 * (no attempt to infer or preserve alignment across multiple lines).
 * Reuses computeSegmentEdit()'s own ordinary content-exposure logic
 * unchanged, by calling it with isTrailingComment overridden to false —
 * safe because a genuinely trailing segment always has real code before
 * it, so that path never widens editStart on its own. The gap is found
 * the same way the delete-entirely branch isolates it, normalised and
 * prepended separately.
 */
function computeTrailingUncommentEdit( text, segment ) {

	var gapStart = segment.start;

	while ( gapStart > 0 && /[ \t]/.test( text[ gapStart - 1 ] ) ) { gapStart--; }

	var gap				= text.slice( gapStart, segment.start );
	var normalisedGap	= normaliseWhitespace( gap );
	var ordinaryEdit	= computeSegmentEdit( text, Object.assign( {}, segment, { isTrailingComment: false } ) );

	return { start: gapStart, end: ordinaryEdit.end, replacement: normalisedGap + ordinaryEdit.replacement };

}

/**
 * Applies computeSegmentEdit() for every given segment to text in one
 * pass, returning the fully-edited result. Edits are applied last-to-
 * first by position, so replacing a later segment never shifts the
 * position an earlier one still needs. useTrailingUncomment defaults to
 * falsy, preserving Remove or Uncomment Trailing Comments' own behaviour
 * where trailing segments are handled per its own resolved choice —
 * only Uncomment's own selection-based path passes it explicitly.
 */
function applySegmentEdits( text, segments, useTrailingUncomment ) {

	var edits = segments
		.map( function( seg ) {
			return ( useTrailingUncomment && seg.isTrailingComment )
				? computeTrailingUncommentEdit( text, seg )
				: computeSegmentEdit( text, seg );
		} )
		.sort( function( a, b ) { return b.start - a.start; } );

	var result = text;

	edits.forEach( function( edit ) {
		result = result.slice( 0, edit.start ) + edit.replacement + result.slice( edit.end );
	} );

	return result;

}


/**
 * Where a style sits in the comment hierarchy: 1 (line-kind, no spatial
 * boundary concept), 2 (multiline-capable, either shape — C
 * Multiline/HTML), 3 (JSDoc only, with its own per-line marker too). A
 * level-1 request always errors against an existing level-2/3 comment;
 * a level-2/3 request supersedes an existing level-2, but not level-3.
 */
function commentLevel( style ) {
	if ( style.kind === 'line' ) { return 1; }
	if ( style.kind === 'block' && style.linePrefix ) { return 3; }
	return 2;
}

/**
 * Classifies a no-selection cursor position relative to any existing
 * marker-based comment it might be at or inside — line-kind styles have
 * no spatial boundary concept, so this only returns other than
 * 'unrelated' when the comment has real markers. 'unrelated': no marker-
 * based comment here. 'boundary': cursor is on the same line as the
 * open/close marker but outside the marker text itself — a new comment
 * goes on a freshly-inserted adjacent line instead of touching the
 * existing one. 'inside': cursor is on an interior line, or within the
 * marker text itself — the caller decides what happens based on
 * commentLevel().
 */
function classifyCursorPosition( allLines, line, character, allowedKeys, strict ) {

	var existing = detectExistingComment( allLines, line, line, allowedKeys, strict );

	if ( ! existing || existing.style.kind === 'line' ) {
		return { type: 'unrelated' };
	}

	/*
	 * Self-contained single line: both boundaries sit on the same line,
	 * so they're checked together here rather than falling through to
	 * the startLine/endLine branches below, which would only ever reach
	 * the first of the two.
	 */
	if ( existing.startLine === existing.endLine ) {

		var soloText		= allLines[ line ];
		var soloMarkerStart	= getLeadingWhitespace( soloText ).length;
		var soloContentEnd	= soloText.replace( /\s+$/, '' ).length;

		if ( character <= soloMarkerStart )	{ return { type: 'boundary', edge: 'before', existing: existing }; }
		if ( character >= soloContentEnd )		{ return { type: 'boundary', edge: 'after', existing: existing }; }
		return { type: 'inside', existing: existing };

	}

	if ( line === existing.startLine ) {

		var markerStart = getLeadingWhitespace( allLines[ line ] ).length;

		if ( character <= markerStart ) { return { type: 'boundary', edge: 'before', existing: existing }; }
		return { type: 'inside', existing: existing };

	}

	if ( line === existing.endLine ) {

		var contentEnd = allLines[ line ].replace( /\s+$/, '' ).length;

		if ( character >= contentEnd ) { return { type: 'boundary', edge: 'after', existing: existing }; }
		return { type: 'inside', existing: existing };

	}

	if ( line > existing.startLine && line < existing.endLine ) {
		return { type: 'inside', existing: existing };
	}

	return { type: 'unrelated' };

}

function addComment( lines, style, baseIndent, strict ) {

	if ( style.kind === 'block' )	{ return applyBlockComment( lines, style, baseIndent ); }
	if ( style.kind === 'line' )	{ return applyLineComment( lines, style, strict ); }
	if ( style.kind === 'inline' )	{ return applyInlineComment( lines, style, baseIndent ).split( '\n' ); }

	return lines;

}

/**
 * How many separate comments an addComment() call actually produced, for
 * the status bar/modal message. Not simply "how many lines were
 * selected": a block or inline style always produces one comment (one
 * shared wrapper), while a line-kind style comments each line
 * independently. Counts line-by-line differences between beforeLines
 * and afterLines rather than duplicating applyLineComment()'s own skip
 * logic — a line left untouched is identical before and after, so it's
 * correctly not counted.
 */
function countAddedComments( beforeLines, afterLines, style ) {

	if ( style.kind !== 'line' ) { return 1; }

	var count = 0;

	for ( var i = 0; i < afterLines.length; i++ ) {
		if ( beforeLines[i] !== afterLines[i] ) { count++; }
	}

	return Math.max( count, 1 );

}

function removeComment( allLines, startLine, endLine, style ) {

	if ( style.kind === 'block' )	{ return removeBlockComment( allLines, startLine, endLine, style ); }
	if ( style.kind === 'line' )	{ return removeLineComment( allLines, startLine, endLine, style ); }

	if ( style.kind === 'inline' ) {
		var text = allLines.slice( startLine, endLine + 1 ).join( '\n' );
		return removeInlineComment( text, style ).split( '\n' );
	}

	return allLines.slice( startLine, endLine + 1 );

}
