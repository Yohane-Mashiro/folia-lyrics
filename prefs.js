import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function connectSetting(settings, key, callback, row) {
    const signalId = settings.connect(`changed::${key}`, callback);
    row.connect('destroy', () => settings.disconnect(signalId));
}

function addComboRow(group, settings, key, title, subtitle, options) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(options.map(option => option.label)),
    });

    let updating = false;
    const syncFromSettings = () => {
        const value = settings.get_string(key);
        const index = options.findIndex(option => option.value === value);
        updating = true;
        row.selected = index >= 0 ? index : 0;
        updating = false;
    };

    row.connect('notify::selected', () => {
        if (updating)
            return;
        const option = options[row.selected];
        if (option && settings.get_string(key) !== option.value)
            settings.set_string(key, option.value);
    });
    connectSetting(settings, key, syncFromSettings, row);
    syncFromSettings();
    group.add(row);
    return row;
}

function addEntryRow(group, settings, key, title, subtitle) {
    const row = new Adw.EntryRow({
        title,
        show_apply_button: false,
    });
    if (subtitle)
        row.tooltip_text = subtitle;

    const syncFromSettings = () => {
        const value = settings.get_string(key);
        if (row.text !== value)
            row.text = value;
    };

    row.connect('changed', () => {
        if (settings.get_string(key) !== row.text)
            settings.set_string(key, row.text);
    });
    connectSetting(settings, key, syncFromSettings, row);
    syncFromSettings();
    group.add(row);
    return row;
}

function addSpinRow(group, settings, key, title, subtitle,
    lower, upper, step) {
    const adjustment = new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        page_increment: step * 5,
        value: settings.get_uint(key),
    });
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment,
        digits: 0,
    });

    let updating = false;
    const syncFromSettings = () => {
        updating = true;
        row.value = settings.get_uint(key);
        updating = false;
    };

    row.connect('notify::value', () => {
        if (updating)
            return;
        const value = Math.round(row.value);
        if (settings.get_uint(key) !== value)
            settings.set_uint(key, value);
    });
    connectSetting(settings, key, syncFromSettings, row);
    syncFromSettings();
    group.add(row);
    return row;
}

function addSwitchRow(group, settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', 0);
    group.add(row);
    return row;
}

export default class YohaneMashiroPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('folia-lyrics'),
            icon_name: 'audio-x-generic-symbolic',
        });
        window.add(page);

        const mediaGroup = new Adw.PreferencesGroup({
            title: _('媒体'),
            description: _('歌词服务提供同步歌词快照，MPRIS 提供播放进度。'),
        });
        page.add(mediaGroup);

        addComboRow(mediaGroup, settings, 'display-mode',
            _('显示模式'),
            _('自动模式在没有歌词时显示 MPRIS 媒体标题。'),
            [
                {value: 'auto', label: _('同步歌词，缺失时显示标题')},
                {value: 'mpris', label: _('仅显示媒体标题')},
            ]);
        addComboRow(mediaGroup, settings, 'lyric-text-priority',
            _('歌词文本优先级'),
            _('翻译按整行时间同步；没有翻译时回退到原文。'),
            [
                {value: 'original', label: _('原文')},
                {value: 'translation', label: _('翻译')},
            ]);
        addEntryRow(mediaGroup, settings, 'player-match',
            _('歌词播放器匹配'),
            _('按英文逗号分隔 MPRIS 身份、桌面入口或总线名称片段，不区分大小写。留空表示接受任意播放器。'));

        const apiGroup = new Adw.PreferencesGroup({
            title: _('歌词接口'),
        });
        page.add(apiGroup);
        addEntryRow(apiGroup, settings, 'api-url',
            _('歌词接口地址'),
            _('填写兼容当前歌词响应格式的接口地址。'));
        addSpinRow(apiGroup, settings, 'poll-interval',
            _('轮询间隔'),
            _('两次歌词快照请求之间的时间，单位为毫秒。'),
            500, 5000, 50);

        const panelGroup = new Adw.PreferencesGroup({
            title: _('面板'),
        });
        page.add(panelGroup);
        addComboRow(panelGroup, settings, 'panel-position',
            _('面板位置'),
            _('修改后立即应用。'),
            [
                {value: 'left', label: _('左侧')},
                {value: 'center', label: _('居中')},
                {value: 'right', label: _('右侧')},
            ]);
        addSpinRow(panelGroup, settings, 'panel-index',
            _('面板序号'),
            _('在所选分区中的位置，0 表示最前方。'),
            0, 20, 1);
        addSpinRow(panelGroup, settings, 'max-width',
            _('最大歌词宽度'),
            _('超出此宽度的歌词会自动滚动。'),
            120, 640, 10);
        addSwitchRow(panelGroup, settings, 'glow',
            _('当前词光晕'),
            _('为正在播放的歌词词项添加轻微文字光晕。'));

    }
}
