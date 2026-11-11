import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    buildCharacterTimings,
    findActiveLine,
    formatTime,
    normalizeResponse,
    signature,
    wordState,
} from './lyricModel.js';
import {createMprisManager} from './mpris.js';

const POPUP_PADDING = 16;
const MIN_VIEWPORT_WIDTH = 40;

function readConfiguration(settings) {
    return {
        displayMode: settings.get_string('display-mode'),
        lyricTextPriority: settings.get_string('lyric-text-priority'),
        apiUrl: settings.get_string('api-url').trim(),
        playerMatch: settings.get_string('player-match'),
        maxWidth: settings.get_uint('max-width'),
        pollInterval: settings.get_uint('poll-interval'),
        glow: settings.get_boolean('glow'),
        detailPopup: settings.get_boolean('detail-popup'),
        popupWidth: settings.get_uint('popup-width'),
        popupHideDelay: settings.get_uint('popup-hide-delay'),
        panelPosition: settings.get_string('panel-position'),
        panelIndex: settings.get_uint('panel-index'),
    };
}

function setReactive(actor, reactive) {
    actor.reactive = reactive;
    actor.can_focus = reactive;
    actor.opacity = reactive ? 255 : 92;
}

function makeWordLabel(text, styleClass = 'yohane-mashiro-word') {
    const label = new St.Label({
        text,
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.line_wrap = false;
    label.clutter_text.set_line_alignment(Pango.Alignment.LEFT);
    return label;
}

function createColorAttribute(start, end, red, green, blue) {
    const attribute = Pango.attr_foreground_new(red, green, blue);
    attribute.start_index = start;
    attribute.end_index = end;
    return attribute;
}

function getSystemAccentColor(widget) {
    try {
        // The label has `.accent`, whose CSS color is -st-accent-color.
        // Reading the computed `color` property resolves the system accent.
        const color = widget.get_theme_node().get_color('color');
        // Clutter exposes 8-bit channels, while Pango attributes require
        // 16-bit channels. Values such as 0xd5 must become 0xd5d5, otherwise
        // the accent renders almost black.
        return [
            color.red * 257,
            color.green * 257,
            color.blue * 257,
        ];
    } catch {
        return null;
    }
}

function applyLyricProgress(label, line, text, position) {
    const characters = Array.from(text);
    if (!line || characters.length === 0) {
        label.clutter_text.attributes = null;
        return;
    }

    const timings = buildCharacterTimings(line, text);
    const encoder = new TextEncoder();
    const byteOffsets = [0];
    for (const character of characters)
        byteOffsets.push(byteOffsets.at(-1) + encoder.encode(character).length);

    let playedCount = 0;
    let currentIndex = -1;
    for (let i = 0; i < timings.length; i++) {
        const timing = timings[i];
        if (position >= timing.endTime) {
            playedCount = i + 1;
            continue;
        }
        if (position >= timing.startTime)
            currentIndex = i;
        break;
    }

    const playedEnd = byteOffsets[playedCount];
    const currentEnd = currentIndex >= 0
        ? byteOffsets[currentIndex + 1]
        : playedEnd;
    const totalEnd = byteOffsets.at(-1);
    const accent = getSystemAccentColor(label);
    const characterProgress = currentIndex >= 0
        ? Math.max(0, Math.min(1,
            (position - timings[currentIndex].startTime) /
                Math.max(0.001,
                    timings[currentIndex].endTime -
                    timings[currentIndex].startTime)))
        : 0;

    const attributes = new Pango.AttrList();
    attributes.insert(createColorAttribute(
        0, totalEnd, 0xffff, 0xffff, 0xffff));

    if (playedEnd > 0) {
        if (accent) {
            attributes.insert(createColorAttribute(
                0, playedEnd, ...accent));
        }
    }

    if (currentEnd > playedEnd) {
        if (accent) {
            // Blend the current character continuously from white toward the
            // accent color. The 33 ms animation timer makes this visually
            // smooth instead of changing only when a new character starts.
            const blend = characterProgress;
            const currentColor = accent.map(channel =>
                Math.round(0xffff * (1 - blend) + channel * blend));
            attributes.insert(createColorAttribute(
                byteOffsets[currentIndex], currentEnd, ...currentColor));
        }
        const weight = Pango.attr_weight_new(Pango.Weight.BOLD);
        weight.start_index = byteOffsets[currentIndex];
        weight.end_index = currentEnd;
        attributes.insert(weight);
    }

    label.clutter_text.attributes = attributes;
}

function setPausedStyle(label, isPaused) {
    if (label._yohaneMashiroPaused === isPaused)
        return;
    label._yohaneMashiroPaused = isPaused;

    if (!isPaused) {
        label.clutter_text.attributes = null;
        return;
    }

    const attributes = new Pango.AttrList();
    attributes.insert(Pango.attr_strikethrough_new(true));
    label.clutter_text.attributes = attributes;
}

function updateWordLabel(label, word, position, isPaused) {
    setPausedStyle(label, isPaused);

    if (word?.isMprisTitle) {
        label.remove_style_class_name('current');
        label.remove_style_class_name('past');
        label.remove_style_class_name('future');
        label.add_style_class_name('mpris-title');
        label.opacity = 255;
        return;
    }

    const state = wordState(word, position);
    label.remove_style_class_name('current');
    label.remove_style_class_name('past');
    label.remove_style_class_name('future');
    label.add_style_class_name(state);
    label.opacity = state === 'current' ? 255 : state === 'past' ? 184 : 77;

}

class LyricsPopupItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super({
            reactive: false,
            activate: false,
            can_focus: false,
        });
        this.add_style_class_name('yohane-mashiro-popup-item');
    }

    activate() {
        // The popup contains its own transport buttons. Activating the item
        // itself must not close the menu.
    }
}

const LeftAlignedLayout = GObject.registerClass(
class LeftAlignedLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width(container, forHeight) {
        const child = container.get_first_child();
        return child
            ? child.get_preferred_width(forHeight)
            : [0, 0];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const child = container.get_first_child();
        return child
            ? child.get_preferred_height(forWidth)
            : [0, 0];
    }

    vfunc_allocate(container, box) {
        container.set_allocation(box);

        const child = container.get_first_child();
        if (!child)
            return;

        const [, naturalWidth] = child.get_preferred_width(-1);
        const [, naturalHeight] = child.get_preferred_height(naturalWidth);
        const availableHeight = box.y2 - box.y1;
        const childBox = new Clutter.ActorBox();

        // Always anchor the content row to the left edge. Allocate its full
        // natural width even when it extends beyond the viewport so clipping
        // and marquee scrolling continue to work.
        childBox.x1 = box.x1;
        childBox.x2 = box.x1 + naturalWidth;
        childBox.y1 = box.y1 +
            Math.max(0, Math.floor((availableHeight - naturalHeight) / 2));
        childBox.y2 = childBox.y1 + naturalHeight;
        child.allocate(childBox);
    }
});

export class YohaneMashiroIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super(0.5, _('folia-lyrics'));

        this._settings = settings;
        this._config = readConfiguration(settings);
        this._destroyed = false;
        this._lyric = null;
        this._lyricSignature = '';
        this._apiAvailable = false;
        this._apiError = '';
        this._fetchPending = false;
        this._fetchGeneration = 0;
        this._lyricsTimerId = 0;
        this._popupHideTimerId = 0;
        this._marqueeTimerId = 0;
        this._lyricAnimationTimerId = 0;
        this._marqueeElapsed = 0;
        this._lastMarqueeTick = 0;
        this._scrollDistance = 0;
        this._panelLabels = [];
        this._panelSignature = '';
        this._popupWordLabels = [];
        this._popupWordSignature = '';
        this._popupArtUrl = '';
        this._coverActor = null;
        this._mpris = null;
        this._progressDragging = false;
        this._dragSeekPosition = -1;

        this._buildPanel();
        this._buildPopup();
        this._connectEvents();

        this._soupSession = new Soup.Session({timeout: 2});
        this._settingsChangedId = this._settings.connect(
            'changed', this._onSettingsChanged.bind(this));

        this._startMpris();
        this._syncPolling();
        this._refreshPresentation();
    }

    get _activePlayer() {
        return this._mpris?.activePlayer ?? null;
    }

    get _lyricPlayerActive() {
        if (!this._mpris || !this._activePlayer)
            return false;
        return this._mpris.matchesPlayer(this._activePlayer);
    }

    get _position() {
        return this._activePlayer?.playbackPosition ?? -1;
    }

    get _playbackRunning() {
        return this._activePlayer?.playing === true;
    }

    get _currentLine() {
        if (this._config.displayMode === 'mpris' || !this._lyricPlayerActive)
            return null;
        return findActiveLine(this._lyric, this._lyricClockPosition);
    }

    get _lyricClockPosition() {
        const clipStart = Number(this._lyric?.clipStartMs ?? 0) / 1000;
        return this._position + (Number.isFinite(clipStart) ? clipStart : 0);
    }

    get _showingTranslation() {
        const line = this._currentLine;
        return this._config.lyricTextPriority === 'translation' &&
            !!line && Array.isArray(line.translationWords) &&
            line.translationWords.length > 0;
    }

    get _mprisTitle() {
        const player = this._activePlayer;
        if (player)
            return String(player.title || player.artist || '').trimStart();
        return String(this._lyric?.title || this._lyric?.artist || '')
            .trimStart();
    }

    get _showingMprisTitle() {
        return this._currentLine === null && this._mprisTitle !== '';
    }

    get _currentWords() {
        const line = this._currentLine;
        if (line && Array.isArray(line.words)) {
            return this._showingTranslation
                ? line.translationWords
                : line.words;
        }

        if (this._showingMprisTitle) {
            return [{
                text: this._mprisTitle,
                startTime: 0,
                endTime: 0,
                isMprisTitle: true,
            }];
        }

        return [];
    }

    get _currentText() {
        const line = this._currentLine;
        if (line) {
            return String(this._showingTranslation
                ? line.translation
                : line.text || '');
        }
        return this._showingMprisTitle ? this._mprisTitle : '';
    }

    get _hasLine() {
        return this._currentWords.length > 0;
    }

    get _afterLyrics() {
        return this._lyric !== null &&
            this._lyricPlayerActive &&
            Array.isArray(this._lyric.lines) &&
            this._lyric.lines.length > 0 &&
            this._lyricClockPosition >= this._lyric.lines.at(-1).endTime;
    }

    get _trackLabel() {
        if (this._lyric && this._lyricPlayerActive) {
            return [this._lyric.title || '', this._lyric.artist || '']
                .filter(value => value !== '').join(' — ');
        }

        const player = this._activePlayer;
        if (!player && this._lyric) {
            return [this._lyric.title || '', this._lyric.artist || '']
                .filter(value => value !== '').join(' — ');
        }
        return player
            ? [player.title || '', player.artist || '']
                .filter(value => value !== '').join(' — ')
            : '';
    }

    _buildPanel() {
        this._row = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
            y_expand: false,
        });
        this._viewport = new St.Widget({
            style_class: 'yohane-mashiro-viewport',
            layout_manager: new LeftAlignedLayout(),
            clip_to_allocation: true,
            width: MIN_VIEWPORT_WIDTH,
            height: 24,
        });
        this._viewport.add_child(this._row);
        this.add_child(this._viewport);
        this.visible = false;
    }

    _buildPopup() {
        this._popupItem = new LyricsPopupItem();
        this._popupContent = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._popupContent.add_style_class_name('yohane-mashiro-popup');
        this._popupItem.add_child(this._popupContent);
        this.menu.addMenuItem(this._popupItem);

        const header = new St.Widget({
            layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                spacing: 10,
            }),
            x_expand: true,
        });
        this._popupContent.add_child(header);

        this._coverBin = new St.Bin({
            style_class: 'yohane-mashiro-cover',
            width: 72,
            height: 72,
        });
        header.add_child(this._coverBin);
        this._showCoverPlaceholder();

        const trackDetails = new St.Widget({
            layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                spacing: 3,
            }),
            x_expand: true,
        });
        header.add_child(trackDetails);

        this._popupTitle = new St.Label({
            style_class: 'yohane-mashiro-track-title',
        });
        this._popupTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        trackDetails.add_child(this._popupTitle);

        this._popupArtist = new St.Label({
            style_class: 'yohane-mashiro-track-detail',
            opacity: 168,
        });
        this._popupArtist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        trackDetails.add_child(this._popupArtist);

        this._popupAlbum = new St.Label({
            style_class: 'yohane-mashiro-track-detail',
            opacity: 122,
        });
        this._popupAlbum.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        trackDetails.add_child(this._popupAlbum);

        this._progressTrack = new St.Widget({
            style_class: 'yohane-mashiro-progress-track',
            x_expand: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._progressFill = new St.Widget({
            style_class: 'yohane-mashiro-progress-fill',
            width: 0,
            y: 4,
        });
        this._progressTrack.add_child(this._progressFill);
        this._progressTrack.reactive = true;
        this._progressTrack.track_hover = true;
        this._progressTrack.connect('button-press-event',
            (_actor, event) => this._onProgressPress(event));
        this._progressTrack.connect('motion-event',
            (_actor, event) => this._onProgressMotion(event));
        this._progressTrack.connect('button-release-event',
            (_actor, event) => this._onProgressRelease(event));
        this._popupContent.add_child(this._progressTrack);

        const timeRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        this._popupContent.add_child(timeRow);

        this._elapsedLabel = new St.Label({
            text: '0:00',
            style_class: 'yohane-mashiro-time',
            x_expand: true,
            opacity: 168,
        });
        timeRow.add_child(this._elapsedLabel);

        this._totalLabel = new St.Label({
            text: '0:00',
            style_class: 'yohane-mashiro-time',
            x_align: Clutter.ActorAlign.END,
            opacity: 122,
        });
        timeRow.add_child(this._totalLabel);

        this._separator = new St.Widget({
            style_class: 'yohane-mashiro-separator',
            x_expand: true,
        });
        this._popupContent.add_child(this._separator);

        this._popupLine = new St.Label({
            style_class: 'yohane-mashiro-popup-lyric',
            x_expand: true,
        });
        this._popupLine.clutter_text.line_wrap = true;
        this._popupLine.clutter_text.line_wrap_mode =
            Pango.WrapMode.WORD_CHAR;
        this._popupContent.add_child(this._popupLine);

        this._popupTranslation = new St.Label({
            style_class: 'yohane-mashiro-translation',
            opacity: 178,
        });
        this._popupTranslation.clutter_text.line_wrap = true;
        this._popupTranslation.clutter_text.line_wrap_mode =
            Pango.WrapMode.WORD_CHAR;
        this._popupContent.add_child(this._popupTranslation);

        this._popupStatus = new St.Label({
            style_class: 'yohane-mashiro-status',
            opacity: 132,
        });
        this._popupStatus.clutter_text.line_wrap = true;
        this._popupStatus.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._popupContent.add_child(this._popupStatus);

        const controls = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        controls.add_style_class_name('yohane-mashiro-controls');
        this._popupContent.add_child(controls);

        this._previousButton = this._makeTransportButton(
            'media-skip-backward-symbolic',
            () => this._activePlayer?.previous());
        controls.add_child(this._previousButton);

        this._playButton = this._makeTransportButton(
            'media-playback-start-symbolic',
            () => this._activePlayer?.togglePlaying());
        controls.add_child(this._playButton);

        this._nextButton = this._makeTransportButton(
            'media-skip-forward-symbolic',
            () => this._activePlayer?.next());
        controls.add_child(this._nextButton);

        this._resizePopup();
    }

    _makeTransportButton(iconName, callback) {
        const button = new St.Button({
            style_class: 'icon-button',
            child: new St.Icon({
                icon_name: iconName,
                icon_size: 16,
            }),
        });
        button.connect('clicked', callback);
        return button;
    }

    _connectEvents() {
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._updatePopup();
        });
        this.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();
            if (button === 2 || button === 3)
                this._fetchLyrics();
            return button === 1
                ? Clutter.EVENT_PROPAGATE
                : Clutter.EVENT_STOP;
        });
        this.connect('destroy', () => this._cleanup());
    }

    _startMpris() {
        createMprisManager().then(manager => {
            if (this._destroyed) {
                manager?.destroy();
                return;
            }
            if (!manager)
                return;

            this._mpris = manager;
            manager.setPlayerMatch(this._config.playerMatch);
            manager.connect('changed', () => this._onMprisChanged());
            manager.connect('track-changed', () => {
                this._lyric = null;
                this._lyricSignature = '';
                this._fetchLyrics();
            });
            this._onMprisChanged();
        });
    }

    _onMprisChanged() {
        if (this._destroyed)
            return;
        this._refreshPresentation();
    }

    _onSettingsChanged(_settings, key) {
        const oldConfig = this._config;
        this._config = readConfiguration(this._settings);

        if (key === 'glow' || key === 'detail-popup') {
            if (!this._config.detailPopup)
                this._closeDetailPopup();
        }
        if (key === 'popup-width') {
            this._resizePopup();
            this._updatePopup();
        }
        if (key === 'player-match') {
            this._mpris?.setPlayerMatch(this._config.playerMatch);
        }
        if (key === 'display-mode' ||
            key === 'api-url' ||
            key === 'poll-interval') {
            this._fetchGeneration++;
            this._syncPolling();
        }
        if (key === 'lyric-text-priority' || key === 'max-width')
            this._panelSignature = '';

        if (oldConfig.glow !== this._config.glow)
            this._syncThemeClasses();

        this._refreshPresentation();
    }

    _syncPolling() {
        if (this._lyricsTimerId) {
            GLib.source_remove(this._lyricsTimerId);
            this._lyricsTimerId = 0;
        }
        if (this._config.displayMode === 'mpris')
            return;

        this._fetchLyrics();
        this._lyricsTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, this._config.pollInterval, () => {
                this._fetchLyrics();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _fetchLyrics() {
        if (this._destroyed ||
            this._fetchPending ||
            this._config.displayMode === 'mpris')
            return;
        if (!this._config.apiUrl) {
            this._markApiUnavailable('empty API URL');
            return;
        }

        let message;
        try {
            message = Soup.Message.new('GET', this._config.apiUrl);
        } catch {
            this._markApiUnavailable('invalid API URL');
            return;
        }
        if (!message) {
            this._markApiUnavailable('invalid API URL');
            return;
        }

        message.get_request_headers().append('Cache-Control', 'no-cache');
        const generation = ++this._fetchGeneration;
        this._fetchPending = true;

        this._soupSession.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                if (this._destroyed || generation !== this._fetchGeneration) {
                    this._fetchPending = false;
                    return;
                }

                this._fetchPending = false;
                let bytes;
                try {
                    bytes = session.send_and_read_finish(result);
                } catch {
                    this._markApiUnavailable('connection failed');
                    return;
                }

                if (message.get_status() < 200 || message.get_status() >= 300) {
                    this._markApiUnavailable(
                        `HTTP ${message.get_status()}`);
                    return;
                }

                let text;
                try {
                    text = new TextDecoder().decode(bytes.get_data());
                } catch {
                    this._markApiUnavailable('invalid response encoding');
                    return;
                }
                this._acceptLyrics(text);
            });
    }

    _acceptLyrics(raw) {
        let parsed;
        try {
            parsed = JSON.parse(String(raw || '').trim());
        } catch {
            this._markApiUnavailable('invalid JSON');
            return;
        }

        const normalized = normalizeResponse(parsed);
        const nextSignature = signature(normalized);
        this._apiAvailable = true;
        this._apiError = '';

        if (nextSignature !== this._lyricSignature) {
            this._lyricSignature = nextSignature;
            this._lyric = normalized;
            console.debug(`[folia-lyrics] 歌词已更新：${normalized?.lines.length ?? 0} 行`);
            this._refreshPresentation();
        }
    }

    _markApiUnavailable(reason) {
        this._apiAvailable = false;
        this._apiError = reason || 'connection failed';
        this._lyricSignature = '';
        this._lyric = null;
        this._refreshPresentation();
    }

    _refreshPresentation() {
        if (this._destroyed)
            return;

        const hasLine = this._hasLine;
        const wasVisible = this.visible;
        this.visible = hasLine;
        if (!hasLine && this.menu.isOpen)
            this._closeDetailPopup();
        if (!wasVisible && hasLine)
            this._marqueeElapsed = 0;

        this._syncThemeClasses();
        this._renderPanel();
        this._syncLyricAnimation();
        this._syncMarquee();
        this._updatePopup();

        const player = this._activePlayer;
        if (player) {
            const parts = [];
            if (this._trackLabel)
                parts.push(this._trackLabel);
            if (!this._showingMprisTitle && this._currentText)
                parts.push(this._currentText);
            this.accessible_name = parts.join('\n') || _('folia-lyrics');
        } else {
            this.accessible_name = _('folia-lyrics：没有媒体播放器');
        }
    }

    _syncThemeClasses() {
        if (this._config.glow)
            this.add_style_class_name('yohane-mashiro-glow');
        else
            this.remove_style_class_name('yohane-mashiro-glow');

        if (this._playbackRunning)
            this.remove_style_class_name('yohane-mashiro-paused');
        else if (this._activePlayer)
            this.add_style_class_name('yohane-mashiro-paused');
        else
            this.remove_style_class_name('yohane-mashiro-paused');
    }

    _renderPanel() {
        // Render the normalized line text as one label. Word fragments from
        // some providers contain punctuation-only tokens; splitting those
        // into separate actors turns a lyric into a row of dots.
        const text = this._currentText;
        const nextSignature = JSON.stringify([
            this._activePlayer?.busName ?? '',
            this._showingTranslation,
            this._showingMprisTitle,
            this._currentLine?.startTime ?? null,
            this._mprisTitle,
            text,
        ]);

        if (nextSignature !== this._panelSignature) {
            this._panelSignature = nextSignature;
            this._row.destroy_all_children();
            this._panelLabel = makeWordLabel(text);
            this._panelLabel.x_align = Clutter.ActorAlign.START;
            this._panelLabel.x_expand = false;
            this._panelLabel.add_style_class_name('accent');
            this._panelLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._row.add_child(this._panelLabel);
            this._marqueeElapsed = 0;
            this._row.translation_x = 0;
            if (this._currentLine) {
                console.log(
                    `[folia-lyrics] 当前歌词：${this._currentLine.startTime.toFixed(2)}s ` +
                    `位置=${this._position.toFixed(2)}s ${text}`);
            }
        }

        applyLyricProgress(this._panelLabel, this._currentLine,
            text, this._lyricClockPosition);
        this._updateViewportWidth();
    }

    _syncLyricAnimation() {
        const shouldRun = this.visible &&
            this._currentLine !== null &&
            this._playbackRunning;

        if (!shouldRun) {
            if (this._lyricAnimationTimerId) {
                GLib.source_remove(this._lyricAnimationTimerId);
                this._lyricAnimationTimerId = 0;
            }
            return;
        }

        if (this._lyricAnimationTimerId)
            return;

        this._lyricAnimationTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 33, () => {
                if (this._destroyed || !this._playbackRunning ||
                    !this._currentLine) {
                    this._lyricAnimationTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                applyLyricProgress(this._panelLabel, this._currentLine,
                    this._currentText, this._lyricClockPosition);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _updateViewportWidth() {
        if (!this._row)
            return;
        const [, naturalWidth] = this._row.get_preferred_width(-1);
        const width = Math.max(MIN_VIEWPORT_WIDTH, this._config.maxWidth);
        this._viewport.width = width;
        this._scrollDistance = Math.max(0, naturalWidth - width);
        this._viewport.queue_relayout();
    }

    _syncMarquee() {
        const shouldRun = this.visible &&
            this._scrollDistance > 0 &&
            this._playbackRunning;

        if (!shouldRun) {
            if (this._marqueeTimerId) {
                GLib.source_remove(this._marqueeTimerId);
                this._marqueeTimerId = 0;
            }
            if (this._scrollDistance === 0)
                this._row.translation_x = 0;
            return;
        }

        if (this._marqueeTimerId)
            return;

        this._lastMarqueeTick = GLib.get_monotonic_time();
        this._marqueeTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 33, () => {
                if (this._destroyed || !this._playbackRunning) {
                    this._marqueeTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                const now = GLib.get_monotonic_time();
                this._marqueeElapsed += (now - this._lastMarqueeTick) / 1000;
                this._lastMarqueeTick = now;

                const travelDuration =
                    Math.max(3000, this._scrollDistance * 42);
                const cycleDuration = 1000 + travelDuration + 1200;
                const phase = this._marqueeElapsed % cycleDuration;
                let offset = 0;

                if (phase >= 1000 && phase < 1000 + travelDuration) {
                    offset = this._scrollDistance *
                        ((phase - 1000) / travelDuration);
                } else if (phase >= 1000 + travelDuration) {
                    offset = this._scrollDistance;
                }

                this._row.translation_x = -offset;
                return GLib.SOURCE_CONTINUE;
            });
    }

    _resizePopup() {
        const width = Math.max(200, this._config.popupWidth - POPUP_PADDING);
        this._popupContent.width = width;
        this._progressTrack.width = width;
        this._popupTranslation.width = width;
        this._popupStatus.width = width;
        this._popupLine.width = width;
        this._updateProgress();
    }

    _updatePopup() {
        if (!this._popupTitle || !this.menu.isOpen)
            return;

        const player = this._activePlayer;
        this._popupTitle.text = player?.title || this._trackLabel ||
            _('未检测到正在播放的音乐');
        this._popupArtist.text = player?.artist || '';
        this._popupArtist.visible = this._popupArtist.text !== '';
        this._popupAlbum.text = player?.album || '';
        this._popupAlbum.visible = this._popupAlbum.text !== '';
        this._elapsedLabel.text = formatTime(Math.max(0, this._position));
        this._totalLabel.text = formatTime(player?.length ?? 0);
        this._totalLabel.visible = (player?.length ?? 0) > 0;
        this._progressTrack.visible = (player?.length ?? 0) > 0;
        this._updateProgress();
        this._updateCover(player?.artUrl || '');

        const line = this._currentLine;
        this._popupLine.text = this._currentText;
        this._popupLine.visible = this._popupLine.text !== '';

        this._popupTranslation.text = line?.translation || '';
        this._popupTranslation.visible = this._popupTranslation.text !== '';
        this._popupStatus.text = this._lyricStatusText();
        this._popupStatus.visible = this._popupLine.text === '';

        setReactive(this._previousButton,
            !!player);
        setReactive(this._playButton,
            !!player);
        setReactive(this._nextButton,
            !!player);

        this._playButton.child.icon_name = this._playbackRunning
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
    }

    _updateProgress() {
        if (!this._progressFill || !this._progressTrack)
            return;

        const length = this._activePlayer?.length ?? 0;
        const position = this._progressDragging
            ? this._dragSeekPosition
            : this._position;
        const progress = length > 0
            ? Math.max(0, Math.min(1, position / length))
            : 0;
        this._progressFill.width = Math.round(
            this._progressTrack.width * progress);
    }

    _progressPositionFromEvent(event) {
        if (!this._activePlayer || this._activePlayer.length <= 0)
            return -1;

        const [pointerX] = event.get_coords();
        const [trackX] = this._progressTrack.get_transformed_position();
        const ratio = Math.max(0, Math.min(1,
            (pointerX - trackX) / this._progressTrack.width));
        return ratio * this._activePlayer.length;
    }

    _onProgressPress(event) {
        if (event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;

        const position = this._progressPositionFromEvent(event);
        if (position < 0)
            return Clutter.EVENT_PROPAGATE;

        this._progressDragging = true;
        this._dragSeekPosition = position;
        this._elapsedLabel.text = formatTime(position);
        this._updateProgress();
        return Clutter.EVENT_STOP;
    }

    _onProgressMotion(event) {
        if (!this._progressDragging)
            return Clutter.EVENT_PROPAGATE;

        const position = this._progressPositionFromEvent(event);
        if (position >= 0) {
            this._dragSeekPosition = position;
            this._elapsedLabel.text = formatTime(position);
            this._updateProgress();
        }
        return Clutter.EVENT_STOP;
    }

    _onProgressRelease(event) {
        if (!this._progressDragging || event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;

        const position = this._progressPositionFromEvent(event);
        if (position >= 0)
            this._dragSeekPosition = position;
        this._activePlayer?.seekTo(this._dragSeekPosition);
        this._progressDragging = false;
        this._dragSeekPosition = -1;
        this._updatePopup();
        return Clutter.EVENT_STOP;
    }

    _updateCover(url) {
        if (url === this._popupArtUrl)
            return;
        this._popupArtUrl = url;

        this._coverActor?.destroy();
        this._coverActor = null;
        if (!url) {
            this._showCoverPlaceholder();
            return;
        }

        try {
            const file = url.includes('://')
                ? Gio.File.new_for_uri(url)
                : Gio.File.new_for_commandline_arg(url);
            this._coverActor = St.TextureCache.get_default()
                .load_file_async(file, 72, 72, 1, 1);
            this._coverBin.child = this._coverActor;
        } catch {
            this._showCoverPlaceholder();
        }
    }

    _showCoverPlaceholder() {
        this._coverActor?.destroy();
        this._coverActor = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'yohane-mashiro-cover-placeholder',
            x_expand: true,
            y_expand: true,
        });
        this._coverBin.child = this._coverActor;
    }

    _lyricStatusText() {
        if (this._config.displayMode === 'mpris')
            return _('仅显示媒体标题');
        if (!this._activePlayer)
            return _('未检测到 MPRIS 播放进度');
        if (!this._lyricPlayerActive)
            return _('当前播放器与歌词接口不匹配');
        if (!this._apiAvailable)
            return this._apiError
                ? `${_('歌词接口不可用')} (${this._apiError})`
                : _('歌词接口不可用');
        if (!this._lyric)
            return _('当前歌曲没有歌词');
        if (this._afterLyrics)
            return _('歌词已播放完毕');
        return _('等待歌词开始');
    }

    _openDetailPopup() {
        if (!this._config.detailPopup || !this._activePlayer || !this._hasLine)
            return;
        if (!this.menu.isOpen)
            this.menu.open();
        this._updatePopup();
    }

    _schedulePopupHide() {
        if (!this.menu.isOpen || this._popupHideTimerId)
            return;

        this._popupHideTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, this._config.popupHideDelay, () => {
                this._popupHideTimerId = 0;
                if (this.hover || this.menu.actor.hover)
                    return GLib.SOURCE_REMOVE;
                this._closeDetailPopup();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelPopupHide() {
        if (!this._popupHideTimerId)
            return;
        GLib.source_remove(this._popupHideTimerId);
        this._popupHideTimerId = 0;
    }

    _closeDetailPopup() {
        this._cancelPopupHide();
        if (this.menu.isOpen)
            this.menu.close();
    }

    _cleanup() {
        this._destroyed = true;
        this._fetchGeneration++;

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        for (const sourceId of [
            this._lyricsTimerId,
            this._popupHideTimerId,
            this._marqueeTimerId,
            this._lyricAnimationTimerId,
        ]) {
            if (sourceId)
                GLib.source_remove(sourceId);
        }
        this._lyricsTimerId = 0;
        this._popupHideTimerId = 0;
        this._marqueeTimerId = 0;
        this._lyricAnimationTimerId = 0;

        this._soupSession?.abort();
        this._soupSession = null;
        this._mpris?.destroy();
        this._mpris = null;
        this._coverActor = null;
        this._settings = null;
    }
}

export default class YohaneMashiroExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new YohaneMashiroIndicator(this._settings);
        this._placeIndicator();

        this._panelPositionId = this._settings.connect(
            'changed::panel-position', () => this._placeIndicator());
        this._panelIndexId = this._settings.connect(
            'changed::panel-index', () => this._placeIndicator());
    }

    _placeIndicator() {
        if (!this._indicator)
            return;

        const position = this._settings.get_string('panel-position');
        const index = Math.max(0, Math.min(20,
            this._settings.get_uint('panel-index')));
        const parent = this._indicator.container.get_parent();
        if (parent)
            parent.remove_child(this._indicator.container);

        if (Main.panel.statusArea[this.uuid] === this._indicator)
            delete Main.panel.statusArea[this.uuid];

        Main.panel.addToStatusArea(this.uuid, this._indicator, index, position);
    }

    disable() {
        if (this._panelPositionId) {
            this._settings.disconnect(this._panelPositionId);
            this._panelPositionId = 0;
        }
        if (this._panelIndexId) {
            this._settings.disconnect(this._panelIndexId);
            this._panelIndexId = 0;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
