import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_ROOT = 'org.mpris.MediaPlayer2';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';
const DBUS_PROPERTIES = 'org.freedesktop.DBus.Properties';

class EventEmitter {
    constructor() {
        this._handlers = new Map();
        this._nextHandlerId = 1;
    }

    connect(name, callback) {
        const id = this._nextHandlerId++;
        const handlers = this._handlers.get(name) ?? [];
        handlers.push({id, callback});
        this._handlers.set(name, handlers);
        return id;
    }

    disconnect(id) {
        for (const [name, handlers] of this._handlers) {
            const index = handlers.findIndex(handler => handler.id === id);
            if (index >= 0) {
                handlers.splice(index, 1);
                if (handlers.length === 0)
                    this._handlers.delete(name);
                return;
            }
        }
    }

    emit(name, ...args) {
        const handlers = this._handlers.get(name);
        if (!handlers)
            return;
        for (const {callback} of [...handlers])
            callback(...args);
    }
}

function unpack(value) {
    if (value === null || value === undefined)
        return undefined;
    if (value instanceof GLib.Variant)
        return value.deep_unpack();
    return value;
}

function stringValue(value) {
    const unpacked = unpack(value);
    return unpacked === null || unpacked === undefined ? '' : String(unpacked);
}

function booleanValue(value, fallback = false) {
    const unpacked = unpack(value);
    return typeof unpacked === 'boolean' ? unpacked : fallback;
}

function parseMetadata(value) {
    const metadata = unpack(value);
    if (!metadata || typeof metadata !== 'object')
        return {};

    const artists = unpack(metadata['xesam:artist']);
    const length = Number(unpack(metadata['mpris:length']));

    return {
        title: stringValue(metadata['xesam:title']).trim(),
        artist: Array.isArray(artists)
            ? artists.map(artist => String(artist)).join(', ')
            : stringValue(artists),
        album: stringValue(metadata['xesam:album']).trim(),
        artUrl: stringValue(metadata['mpris:artUrl']).trim(),
        length: Number.isFinite(length) && length > 0 ? length / 1_000_000 : 0,
        trackId: stringValue(metadata['mpris:trackid']).trim(),
    };
}

export class MprisPlayer extends EventEmitter {
    constructor(connection, busName) {
        super();

        this.busName = busName;
        this.identity = busName.slice(MPRIS_PREFIX.length) || busName;
        this.desktopEntry = '';
        this.ready = false;
        this.gone = false;
        this.playing = false;
        this.position = 0;
        this._positionUpdatedAt = 0;
        this.title = '';
        this.artist = '';
        this.album = '';
        this.artUrl = '';
        this.length = 0;
        this.trackId = '';
        this.canGoNext = false;
        this.canGoPrevious = false;
        this.canPlay = false;
        this.canPause = false;
        this.canTogglePlaying = true;
        this._positionRequestPending = false;
        this._refreshPending = false;
        this._processDescription = null;

        this._proxy = new Gio.DBusProxy({
            g_connection: connection,
            g_name: busName,
            g_object_path: MPRIS_PATH,
            g_interface_name: MPRIS_PLAYER,
            g_flags: Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
        });

        this._propertiesChangedId = this._proxy.connect(
            'g-properties-changed',
            (_proxy, changed) => this._onPropertiesChanged(changed));
        this._proxy.connect('g-signal', (_proxy, sender, signal) => {
            if (signal === 'Seeked')
                this.queryPosition();
        });

        this._proxy.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, result) => {
            try {
                proxy.init_finish(result);
            } catch (error) {
                this.gone = true;
                this.emit('gone', this);
                return;
            }

            this._readCachedProperties();
            this._readRootProperties();
            this.ready = true;
            this.emit('changed', this);
            this.emit('ready', this);
        });
    }

    get trackKey() {
        return `${this.title}\n${this.artist}\n${this.album}`;
    }

    get playbackPosition() {
        if (!this.playing || this._positionUpdatedAt === 0)
            return this.position;

        const elapsed = Math.max(0,
            (GLib.get_monotonic_time() - this._positionUpdatedAt) / 1_000_000);
        return this.position + elapsed;
    }

    _setPosition(position) {
        const seconds = Number(position);
        if (!Number.isFinite(seconds) || seconds < 0)
            return;
        this.position = seconds;
        this._positionUpdatedAt = GLib.get_monotonic_time();
    }

    matchesPlayer(tokens) {
        if (!tokens || tokens.length === 0)
            return true;

        const haystack = [this.identity, this.desktopEntry, this.busName]
            .join('\n').toLowerCase();
        if (tokens.some(token => haystack.includes(token)))
            return true;

        // Electron applications register MPRIS as
        // org.mpris.MediaPlayer2.chromium.instance<PID>. Match the backing
        // process as a fallback so a player match such as "folia" still works.
        const processDescription = this._getProcessDescription();
        return processDescription !== '' &&
            tokens.some(token => processDescription.includes(token));
    }

    _getProcessDescription() {
        if (this._processDescription !== null)
            return this._processDescription;

        this._processDescription = '';
        const match = this.busName.match(/\.instance(\d+)$/);
        if (!match)
            return this._processDescription;

        try {
            const [, contents] = GLib.file_get_contents(`/proc/${match[1]}/cmdline`);
            this._processDescription = new TextDecoder().decode(contents)
                .replaceAll('\0', ' ')
                .toLowerCase();
        } catch {
            // The process may already be gone.
        }
        return this._processDescription;
    }

    _readCachedProperties() {
        const status = this._proxy.get_cached_property('PlaybackStatus');
        const metadata = this._proxy.get_cached_property('Metadata');
        const position = this._proxy.get_cached_property('Position');

        if (status)
            this._setPlaybackStatus(unpack(status));
        if (metadata)
            this._setMetadata(metadata);
        if (position)
            this._setPosition(Number(unpack(position)) / 1_000_000);

        this._setCapability('CanGoNext',
            this._proxy.get_cached_property('CanGoNext'));
        this._setCapability('CanGoPrevious',
            this._proxy.get_cached_property('CanGoPrevious'));
        this._setCapability('CanPlay',
            this._proxy.get_cached_property('CanPlay'));
        this._setCapability('CanPause',
            this._proxy.get_cached_property('CanPause'));
    }

    _readRootProperties() {
        this._getRemoteProperty(MPRIS_ROOT, 'Identity', value => {
            this.identity = value || this.identity;
            this.emit('changed', this);
        });
        this._getRemoteProperty(MPRIS_ROOT, 'DesktopEntry', value => {
            this.desktopEntry = value || '';
            this.emit('changed', this);
        });
    }

    _getRemoteProperty(interfaceName, propertyName, callback) {
        const parameters = new GLib.Variant('(ss)', [interfaceName, propertyName]);
        this._proxy.call(`${DBUS_PROPERTIES}.Get`, parameters,
            Gio.DBusCallFlags.NONE, 1000, null, (proxy, result) => {
                try {
                    const response = proxy.call_finish(result);
                    callback(stringValue(response.deep_unpack()[0]));
                } catch {
                    callback('');
                }
            });
    }

    _onPropertiesChanged(changed) {
        let properties;
        try {
            properties = changed.unpack();
        } catch {
            return;
        }
        this._applyProperties(properties);
    }

    _applyProperties(properties) {
        if (!properties || typeof properties !== 'object')
            return;

        let didChange = false;
        let didChangeTrack = false;

        for (const [name, value] of Object.entries(properties)) {
            if (name === 'PlaybackStatus') {
                this._setPlaybackStatus(unpack(value));
                didChange = true;
            } else if (name === 'Metadata') {
                const oldTrackKey = this.trackKey;
                this._setMetadata(value);
                didChange = true;
                didChangeTrack = oldTrackKey !== this.trackKey;
            } else if (name === 'Position') {
                this._setPosition(Number(unpack(value)) / 1_000_000);
                didChange = true;
            } else if (name.startsWith('Can')) {
                this._setCapability(name, value);
                didChange = true;
            }
        }

        if (didChange)
            this.emit('changed', this);
        if (didChangeTrack) {
            console.log(
                `[folia-lyrics] MPRIS 曲目更新：${this.title || '无标题'} ` +
                `状态=${this.playing ? '播放' : '暂停'}`);
            this.emit('track-changed', this);
        }
    }

    _setPlaybackStatus(value) {
        const playing = String(value || '') === 'Playing';
        if (playing !== this.playing) {
            this.playing = playing;
            // Freeze the current base position on pause and restart local
            // extrapolation from the last sample on resume.
            this._positionUpdatedAt = GLib.get_monotonic_time();
        }
    }

    _setMetadata(value) {
        const metadata = parseMetadata(value);
        this.title = metadata.title || '';
        this.artist = metadata.artist || '';
        this.album = metadata.album || '';
        this.artUrl = metadata.artUrl || '';
        this.length = metadata.length || 0;
        this.trackId = metadata.trackId || '';
    }

    _setCapability(name, value) {
        if (value === null || value === undefined)
            return;
        this[name] = booleanValue(value, this[name]);
    }

    queryPosition() {
        if (this._positionRequestPending || this.gone)
            return;

        this._positionRequestPending = true;
        const parameters = new GLib.Variant('(ss)', [MPRIS_PLAYER, 'Position']);

        this._proxy.call(`${DBUS_PROPERTIES}.Get`, parameters,
            Gio.DBusCallFlags.NONE, 500, null, (proxy, result) => {
                this._positionRequestPending = false;
                try {
                    const response = proxy.call_finish(result);
                    const position = Number(unpack(response.deep_unpack()[0]));
                    this._setPosition(position / 1_000_000);
                    this.emit('changed', this);
                } catch {
                    // Some players omit Position or do not answer while
                    // paused. Keep the last known position instead of
                    // treating the player itself as unavailable.
                }
            });
    }

    refreshAll() {
        if (this._refreshPending || this.gone)
            return;

        this._refreshPending = true;
        const parameters = new GLib.Variant('(s)', [MPRIS_PLAYER]);
        this._proxy.call(`${DBUS_PROPERTIES}.GetAll`, parameters,
            Gio.DBusCallFlags.NONE, 1000, null, (proxy, result) => {
                this._refreshPending = false;
                try {
                    const response = proxy.call_finish(result);
                    this._applyProperties(response.deep_unpack()[0]);
                } catch {
                    // A player can disappear while the request is in flight.
                }
            });
    }

    callMethod(method) {
        if (this.gone)
            return;

        this._proxy.call(method, null, Gio.DBusCallFlags.NONE, 1000, null,
            (_proxy, result) => {
                try {
                    _proxy.call_finish(result);
                } catch {
                    // A player can disappear between the panel click and the
                    // method call. The next bus scan removes it.
                }
            });
    }

    togglePlaying() {
        this.callMethod('PlayPause');
    }

    previous() {
        this.callMethod('Previous');
    }

    next() {
        this.callMethod('Next');
    }

    seekTo(seconds) {
        if (this.gone || !(this.length > 0))
            return;

        const target = Math.max(0, Math.min(this.length, Number(seconds)));
        if (!Number.isFinite(target))
            return;

        const previousPosition = this.position;
        this._setPosition(target);
        this.emit('changed', this);

        let method;
        let parameters;
        if (this.trackId) {
            method = 'SetPosition';
            parameters = new GLib.Variant('(ox)', [
                this.trackId,
                Math.round(target * 1_000_000),
            ]);
        } else {
            method = 'Seek';
            parameters = new GLib.Variant('(x)', [
                Math.round((target - previousPosition) * 1_000_000),
            ]);
        }

        this._proxy.call(method, parameters, Gio.DBusCallFlags.NONE,
            1500, null, (proxy, result) => {
                try {
                    proxy.call_finish(result);
                    this.queryPosition();
                } catch {
                    console.log('[folia-lyrics] 当前播放器不支持拖动进度');
                }
            });
    }

    destroy() {
        this.gone = true;
        if (this._propertiesChangedId) {
            this._proxy.disconnect(this._propertiesChangedId);
            this._propertiesChangedId = 0;
        }
        this._proxy = null;
    }
}

export class MprisManager extends EventEmitter {
    constructor(connection) {
        super();

        this._connection = connection;
        this._players = new Map();
        this._playerMatchTokens = [];
        this._positionTimerId = 0;
        this._stateTimerId = 0;
        this._refreshTimerId = 0;
        this._refreshPending = false;
        this._lastLoggedNames = null;
        this._destroyed = false;

        this._busProxy = new Gio.DBusProxy({
            g_connection: connection,
            g_name: 'org.freedesktop.DBus',
            g_object_path: '/org/freedesktop/DBus',
            g_interface_name: 'org.freedesktop.DBus',
        });

        this._busProxy.connect('g-signal', (_proxy, _sender, signal, parameters) => {
            if (signal !== 'NameOwnerChanged')
                return;
            try {
                const [name] = parameters.deep_unpack();
                if (name.startsWith(MPRIS_PREFIX))
                    this.refreshPlayers();
            } catch {
                // Ignore unexpected NameOwnerChanged payloads.
            }
        });

        this._busProxy.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, result) => {
            try {
                proxy.init_finish(result);
            } catch {
                return;
            }
            this.refreshPlayers();
        });

        this._refreshTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 2, () => {
                this.refreshPlayers();
                return GLib.SOURCE_CONTINUE;
            });

        this._positionTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 200, () => {
                const player = this.activePlayer;
                if (player && player.playing)
                    player.queryPosition();
                return GLib.SOURCE_CONTINUE;
            });
        this._stateTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, () => {
                this.activePlayer?.refreshAll();
                return GLib.SOURCE_CONTINUE;
            });
    }

    get players() {
        return [...this._players.values()].filter(player => player.ready);
    }

    get matchedPlayer() {
        const players = this.players;
        const playingMatch = players.find(player =>
            player.playing && player.matchesPlayer(this._playerMatchTokens));
        if (playingMatch)
            return playingMatch;

        return players.find(player =>
            player.matchesPlayer(this._playerMatchTokens)) ?? null;
    }

    get activePlayer() {
        const players = this.players;
        const matched = this.matchedPlayer;
        const otherPlaying = players.find(player =>
            player.playing && player !== matched);

        // A matched paused player still describes the lyric snapshot when
        // nothing else is playing. If another player really starts playing,
        // it becomes active so the API's snapshot cannot drive the wrong
        // timeline.
        if (matched && (matched.playing || !otherPlaying))
            return matched;
        if (otherPlaying)
            return otherPlaying;

        return players.find(player => player.title || player.artist) ??
            players[0] ?? null;
    }

    setPlayerMatch(value) {
        this._playerMatchTokens = String(value || '').toLowerCase()
            .split(',').map(token => token.trim())
            .filter(token => token.length > 0);
        this.emit('changed', this);
    }

    matchesPlayer(player) {
        return !!player && player.matchesPlayer(this._playerMatchTokens);
    }

    refreshPlayers() {
        if (this._destroyed || this._refreshPending)
            return;

        this._refreshPending = true;
        this._busProxy.call('ListNames', null, Gio.DBusCallFlags.NONE, 1000,
            null, (proxy, result) => {
                this._refreshPending = false;
                if (this._destroyed)
                    return;

                let names;
                try {
                    names = proxy.call_finish(result).deep_unpack()[0];
                } catch {
                    return;
                }

                const available = new Set(names.filter(name =>
                    typeof name === 'string' && name.startsWith(MPRIS_PREFIX)));
                const playerNames = [...available].sort();
                const namesKey = playerNames.join('\n');
                if (namesKey !== this._lastLoggedNames) {
                    this._lastLoggedNames = namesKey;
                    console.log(playerNames.length > 0
                        ? `[folia-lyrics] 检测到 MPRIS 播放器：${playerNames.join(', ')}`
                        : '[folia-lyrics] 未检测到 MPRIS 播放器');
                }

                for (const [name, player] of this._players) {
                    if (available.has(name))
                        continue;
                    this._players.delete(name);
                    player.destroy();
                }

                let added = false;
                for (const name of available) {
                    if (this._players.has(name))
                        continue;

                    const player = new MprisPlayer(this._connection, name);
                    this._players.set(name, player);
                    player.connect('ready', readyPlayer => {
                        console.log(
                            `[folia-lyrics] MPRIS 播放器就绪：${readyPlayer.identity} ` +
                            `状态=${readyPlayer.playing ? '播放' : '暂停'} ` +
                            `标题=${readyPlayer.title || '无'}`);
                    });
                    player.connect('changed', () => this.emit('changed', this));
                    player.connect('track-changed', changedPlayer =>
                        this.emit('track-changed', changedPlayer));
                    player.connect('gone', gonePlayer => {
                        if (this._players.get(gonePlayer.busName) === gonePlayer)
                            this._players.delete(gonePlayer.busName);
                        this.emit('changed', this);
                    });
                    added = true;
                }

                if (added)
                    this.emit('changed', this);
            });
    }

    destroy() {
        this._destroyed = true;

        if (this._refreshTimerId) {
            GLib.source_remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
        if (this._positionTimerId) {
            GLib.source_remove(this._positionTimerId);
            this._positionTimerId = 0;
        }
        if (this._stateTimerId) {
            GLib.source_remove(this._stateTimerId);
            this._stateTimerId = 0;
        }

        for (const player of this._players.values())
            player.destroy();
        this._players.clear();
        this._busProxy = null;
        this._connection = null;
    }
}

export function createMprisManager() {
    return new Promise(resolve => {
        Gio.bus_get(Gio.BusType.SESSION, null, (_source, result) => {
            try {
                const connection = Gio.bus_get_finish(result);
                resolve(new MprisManager(connection));
            } catch {
                resolve(null);
            }
        });
    });
}
