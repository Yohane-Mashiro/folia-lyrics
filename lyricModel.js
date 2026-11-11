// Folia v1 responses are normalized before they reach the Shell actors. This
// keeps malformed optional fields from breaking an indicator mid-render.

function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function textOr(value, fallback) {
    if (value === undefined || value === null)
        return fallback;
    return String(value);
}

function normalizeWord(value, fallbackStart, fallbackEnd, offsetSeconds) {
    if (!value || typeof value !== 'object')
        return null;

    const text = textOr(value.text, '');
    if (text.length === 0)
        return null;

    const rawStartTime = numberOr(value.startTime, fallbackStart);
    let rawEndTime = numberOr(value.endTime, fallbackEnd);
    if (rawEndTime < rawStartTime)
        rawEndTime = rawStartTime;

    return {
        text,
        startTime: rawStartTime + offsetSeconds,
        endTime: rawEndTime + offsetSeconds,
    };
}

function normalizeLine(value, offsetSeconds) {
    if (!value || typeof value !== 'object')
        return null;

    // Some providers put line indentation into the first token. It is not
    // useful in a single-line panel and prevents the marquee from starting at
    // the visible edge.
    const text = textOr(value.text, '').replace(/^\s+/, '');
    const rawStartTime = numberOr(value.startTime, 0);
    let rawEndTime = numberOr(value.endTime, rawStartTime);
    if (rawEndTime < rawStartTime)
        rawEndTime = rawStartTime;

    const startTime = rawStartTime + offsetSeconds;
    const endTime = rawEndTime + offsetSeconds;
    const words = [];
    const sourceWords = Array.isArray(value.words) ? value.words : [];

    for (let i = 0; i < sourceWords.length; i++) {
        const word = normalizeWord(sourceWords[i], rawStartTime,
            rawEndTime, offsetSeconds);
        if (word && words.length === 0)
            word.text = word.text.replace(/^\s+/, '');
        if (word)
            words.push(word);
    }

    // Folia normally supplies words even for line-timed sources. Preserve a
    // fallback for older or incomplete providers.
    if (words.length === 0 && text.length > 0)
        words.push({text, startTime, endTime});

    const line = {text, startTime, endTime, words};
    const translation = textOr(value.translation, '').replace(/^\s+/, '');

    if (translation.length > 0) {
        line.translation = translation;
        line.translationWords = [{
            text: translation,
            startTime,
            endTime,
            isTranslation: true,
        }];
    }

    return line;
}

export function normalizeResponse(value) {
    if (value === null)
        return null;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    if (!Array.isArray(value.lines))
        return null;

    // Compatible providers use milliseconds for the signed global offset,
    // while line and word timings remain in seconds.
    const offsetMs = numberOr(value.offset, 0);
    const offsetSeconds = offsetMs / 1000;
    const lines = [];

    for (const valueLine of value.lines) {
        const line = normalizeLine(valueLine, offsetSeconds);
        if (line && line.text.length > 0 && line.endTime >= line.startTime)
            lines.push(line);
    }

    lines.sort((a, b) => a.startTime - b.startTime);
    if (lines.length === 0)
        return null;

    const result = {
        lines,
        wordByWord: value.wordByWord === true,
        offset: offsetMs,
        clipStartMs: Math.max(0, numberOr(value.clipStartMs, 0)),
    };

    const title = textOr(value.title, '');
    const artist = textOr(value.artist, '');
    if (title.length > 0)
        result.title = title;
    if (artist.length > 0)
        result.artist = artist;

    return result;
}

export function findActiveLine(response, position) {
    const currentTime = numberOr(position, -1);
    if (!response || !Array.isArray(response.lines) || currentTime < 0)
        return null;

    for (let i = 0; i < response.lines.length; i++) {
        const line = response.lines[i];
        if (currentTime < line.startTime)
            break;

        // Keep the previous line visible in an inter-line timing gap. The
        // final line remains until the snapshot is replaced by a new track.
        const displayEnd = i + 1 < response.lines.length
            ? response.lines[i + 1].startTime
            : Infinity;
        if (currentTime < displayEnd)
            return line;
    }

    return null;
}

export function wordState(word, position) {
    const currentTime = numberOr(position, -1);
    if (!word || currentTime < 0)
        return 'future';
    if (currentTime >= word.endTime)
        return 'past';
    if (currentTime >= word.startTime)
        return 'current';
    return 'future';
}

function findCharacterSequence(characters, tokenCharacters, start) {
    outer:
    for (let i = start; i <= characters.length - tokenCharacters.length; i++) {
        for (let j = 0; j < tokenCharacters.length; j++) {
            if (characters[i + j] !== tokenCharacters[j])
                continue outer;
        }
        return i;
    }
    return -1;
}

export function buildCharacterTimings(line, text) {
    const characters = Array.from(text);
    if (characters.length === 0)
        return [];

    const words = Array.isArray(line?.words)
        ? line.words.filter(word => String(word?.text || '').length > 0)
        : [];
    if (words.length === 0) {
        return characters.map((_, index) => {
            const start = line.startTime +
                ((line.endTime - line.startTime) * index / characters.length);
            const end = line.startTime +
                ((line.endTime - line.startTime) * (index + 1) /
                    characters.length);
            return {startTime: start, endTime: end};
        });
    }

    const ranges = [];
    const tokenCharacters = words.map(word => Array.from(String(word.text)));
    const joined = tokenCharacters.flat().join('');
    let cursor = 0;

    if (joined === text) {
        for (let i = 0; i < words.length; i++) {
            const count = tokenCharacters[i].length;
            ranges.push({word: words[i], start: cursor, end: cursor + count});
            cursor += count;
        }
    } else {
        for (let i = 0; i < words.length; i++) {
            const token = tokenCharacters[i];
            let start = findCharacterSequence(characters, token, cursor);
            if (start < 0) {
                start = cursor;
                const remaining = characters.length - cursor;
                const remainingLength = tokenCharacters.slice(i)
                    .reduce((sum, value) => sum + value.length, 0);
                const estimated = i === words.length - 1
                    ? remaining
                    : Math.round(remaining * token.length /
                        Math.max(1, remainingLength));
                ranges.push({
                    word: words[i],
                    start,
                    end: start + Math.max(0, estimated),
                });
                cursor = start + Math.max(0, estimated);
                continue;
            }

            ranges.push({word: words[i], start, end: start + token.length});
            cursor = start + token.length;
        }
    }

    const timings = new Array(characters.length);
    for (const range of ranges) {
        const count = Math.max(1, range.end - range.start);
        const startTime = numberOr(range.word.startTime, line.startTime);
        const endTime = Math.max(startTime,
            numberOr(range.word.endTime, startTime));
        const duration = endTime - startTime;

        for (let i = range.start; i < Math.min(range.end, characters.length);
            i++) {
            const offset = i - range.start;
            timings[i] = {
                startTime: startTime + duration * offset / count,
                endTime: startTime + duration * (offset + 1) / count,
            };
        }
    }

    // Fill any unmapped characters from the surrounding word boundaries.
    for (let i = 0; i < timings.length; i++) {
        if (timings[i])
            continue;
        const previous = timings.slice(0, i).reverse().find(Boolean);
        const next = timings.slice(i + 1).find(Boolean);
        const startTime = previous?.endTime ?? next?.startTime ?? line.startTime;
        const endTime = next?.startTime ?? previous?.endTime ?? line.endTime;
        timings[i] = {
            startTime,
            endTime: Math.max(startTime, endTime),
        };
    }

    return timings;
}

// MPRIS uses seconds. Minutes deliberately continue past an hour instead of
// introducing a width-changing hours field for the common short-track case.
export function formatTime(seconds) {
    let total = Math.floor(numberOr(seconds, 0));
    if (!(total >= 0))
        total = 0;

    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function signature(response) {
    return response === null ? 'null' : JSON.stringify(response);
}
