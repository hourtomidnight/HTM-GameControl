const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderBoardEditor,
  renderAudioEventsCard,
  collectBoardConfig,
  collectAudioEvents,
  AUDIO_EVENT_NAMES,
} = require('../public/config-board.js');
const { validateConfig } = require('../src/config-schema.js');

function sampleState() {
  return {
    sections: [
      { id: 'sec_desk', name: 'Desk', note: 'front of room', order: 5 },
      { name: 'Vault', note: '', order: 9 },
    ],
    steps: [
      {
        id: 'step_1', name: 'Briefcase', sectionId: 'sec_desk', order: 3,
        hints: [
          { id: 'step_1_h1', type: 'text', text: 'Look under the desk', key: 'F1', countsAsClue: true },
          { type: 'audio', mediaRef: 'clue.mp3', label: 'Clue 2', color: '#fff', icon: '🎧' },
        ],
      },
      { name: 'Pendant', sectionId: null, order: 1, hints: [] },
      { name: 'Ungrouped keypad', sectionId: 'nope_missing', order: 2, hints: [
        { type: 'text', text: 'Try 1234' },
      ] },
    ],
    flags: ['Translation given', '  ', 'Door opened', 'Translation given'],
  };
}

test('collectBoardConfig output passes validateConfig and assigns/preserves ids', () => {
  const out = collectBoardConfig(sampleState());
  const res = validateConfig({ sections: out.sections, steps: out.steps, progress: out.progress });
  assert.equal(res.ok, true, JSON.stringify(res.errors));

  assert.equal(out.sections[0].id, 'sec_desk'); // preserved
  assert.equal(out.sections[1].id, 'sec_1');    // assigned, lowest free counter
  assert.equal(out.steps[0].id, 'step_1');      // preserved
  assert.ok(out.steps[1].id && out.steps[1].id !== 'step_1'); // assigned
  assert.equal(out.steps[0].hints[0].id, 'step_1_h1'); // preserved
  assert.equal(out.steps[0].hints[1].id, 'step_1_h2'); // assigned within step
});

test('deterministic: same state twice -> identical ids', () => {
  const a = collectBoardConfig(sampleState());
  const b = collectBoardConfig(sampleState());
  assert.deepEqual(a, b);
});

test('order renumbered 1..n; sectionId resolves or falls back to null', () => {
  const out = collectBoardConfig(sampleState());
  assert.deepEqual(out.sections.map((s) => s.order), [1, 2]);
  assert.deepEqual(out.steps.map((s) => s.order), [1, 2, 3]);
  assert.equal(out.steps[0].sectionId, 'sec_desk');
  assert.equal(out.steps[1].sectionId, null);
  // unresolvable sectionId -> null (ungrouped)
  assert.equal(out.steps[2].sectionId, null);
});

test('a step moved to a real section lands in that section', () => {
  const st = sampleState();
  st.steps[1].sectionId = 'sec_desk';
  const out = collectBoardConfig(st);
  assert.equal(out.steps[1].sectionId, 'sec_desk');
});

test('drop rules: empty-name section, blank hints, nameless hintless step', () => {
  const out = collectBoardConfig({
    sections: [{ name: '', note: 'x', order: 1 }, { name: 'Keep', order: 2 }],
    steps: [
      { name: '', hints: [] }, // dropped: no name, no hints
      { name: 'Has hints', hints: [
        { type: 'text', text: '   ' },     // dropped: blank text
        { type: 'audio', mediaRef: '' },   // dropped: blank mediaRef
        { type: 'text', text: 'real' },    // kept
      ] },
      { name: '', hints: [ { type: 'text', text: 'kept via hint' } ] }, // kept: has a hint
    ],
    flags: [],
  });
  assert.equal(out.sections.length, 1);
  assert.equal(out.sections[0].name, 'Keep');
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[0].hints.length, 1);
  assert.equal(out.steps[0].hints[0].text, 'real');
});

test('countsAsClue defaults true; blank audio label/color/icon omitted', () => {
  const out = collectBoardConfig({
    sections: [],
    steps: [{ name: 'S', hints: [
      { type: 'text', text: 'no flag set' },
      { type: 'audio', mediaRef: 'a.mp3', label: '', color: '  ', icon: '' },
    ] }],
    flags: [],
  });
  const [t, a] = out.steps[0].hints;
  assert.equal(t.countsAsClue, true);
  assert.equal(a.countsAsClue, true);
  assert.ok(!('label' in a));
  assert.ok(!('color' in a));
  assert.ok(!('icon' in a));
});

test('progress.flags: trimmed, non-empty, order preserved, duplicates kept', () => {
  const out = collectBoardConfig(sampleState());
  assert.deepEqual(out.progress.flags, ['Translation given', 'Door opened', 'Translation given']);
});

test('collectAudioEvents: six names, midShow default, volume clamp, disabled keeps file', () => {
  const out = collectAudioEvents({
    volume: 1.7,
    events: {
      start: { file: '  s.mp3 ', enabled: true },
      midShow: { enabled: true },
      lose: { file: 'l.mp3', enabled: false },
    },
  });
  assert.deepEqual(Object.keys(out.events).sort(), AUDIO_EVENT_NAMES.slice().sort());
  assert.equal(out.volume, 1);
  assert.equal(out.events.start.file, 's.mp3');
  assert.equal(out.events.midShow.enabled, true);
  assert.equal(out.events.midShow.atSecondsRemaining, 120);
  assert.equal(Number.isInteger(out.events.midShow.atSecondsRemaining), true);
  assert.equal(out.events.lose.file, 'l.mp3'); // disabled but keeps file
  assert.equal(out.events.lose.enabled, false);
});

test('collectAudioEvents: midShow explicit seconds coerced to positive int; bad volume -> default', () => {
  const out = collectAudioEvents({ volume: 'xyz', events: { midShow: { enabled: true, atSecondsRemaining: 90.7 } } });
  assert.equal(out.events.midShow.atSecondsRemaining, 90);
  assert.equal(out.volume, 0.4);
  const bad = collectAudioEvents({ volume: 0.5, events: { midShow: { enabled: true, atSecondsRemaining: -3 } } });
  assert.equal(bad.events.midShow.atSecondsRemaining, 120);
});

test('collectAudioEvents result validates as config.audio', () => {
  const out = collectAudioEvents({ volume: 0.6, events: { midShow: { enabled: true } } });
  const res = validateConfig({ audio: { volume: out.volume, events: out.events } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('renderBoardEditor: names, hint text, audio picker + mediaRef, flags, data attrs, stub button', () => {
  const cfg = collectBoardConfig(sampleState());
  const html = renderBoardEditor({ sections: cfg.sections, steps: cfg.steps, progress: cfg.progress });
  assert.match(html, /Desk/);
  assert.match(html, /Briefcase/);
  assert.match(html, /Look under the desk/);
  assert.match(html, /Pick media…/);
  assert.match(html, /clue\.mp3/);
  assert.match(html, /Translation given/);
  assert.match(html, /data-role="section"/);
  assert.match(html, /data-id="sec_desk"/);
  assert.match(html, /data-role="hint"/);
  assert.match(html, /data-action="import-checklist" disabled/);
  // hint hotkey field is a capture-friendly .key-capture span, not a free-text input
  assert.match(html, /<span class="key-capture has-key" data-field="key" data-key="F1" tabindex="0">F1<\/span>/);
  assert.doesNotMatch(html, /<input[^>]*data-field="key"/);
});

test('renderBoardEditor: hint key field is a .key-capture span carrying data-field/data-key', () => {
  const withKey = renderBoardEditor({
    sections: [], progress: { flags: [] },
    steps: [{ id: 'step_1', name: 'S', hints: [
      { id: 'step_1_h1', type: 'text', text: 'x', key: 'Ctrl+Shift+K' },
    ] }],
  });
  assert.match(withKey, /class="key-capture has-key"/);
  assert.match(withKey, /data-field="key"/);
  assert.match(withKey, /data-key="Ctrl\+Shift\+K"/);
  assert.match(withKey, />Ctrl\+Shift\+K<\/span>/);

  // no key -> no has-key class, placeholder text, empty data-key
  const noKey = renderBoardEditor({
    sections: [], progress: { flags: [] },
    steps: [{ id: 'step_2', name: 'S2', hints: [{ id: 'step_2_h1', type: 'text', text: 'y' }] }],
  });
  assert.match(noKey, /<span class="key-capture" data-field="key" data-key="" tabindex="0">click to assign<\/span>/);
});

test('renderBoardEditor({}) renders add buttons + empty state, no crash', () => {
  const html = renderBoardEditor({});
  assert.match(html, /data-action="add-section"/);
  assert.match(html, /data-action="add-step"/);
  assert.match(html, /data-role="empty-state"/);
});

test('round-trip: renderBoardEditor -> scrape DOM attrs -> collectBoardConfig reproduces the config', () => {
  // Pins the render <-> DOM-read contract that config.html's save flow depends on
  // (Finding 1). Scrape the same data-role/data-field/data-id attributes that
  // readBoardStateFromDOM() reads, into the same plain-state shape, then collect.
  const cfg = collectBoardConfig(sampleState());
  const html = renderBoardEditor({ sections: cfg.sections, steps: cfg.steps, progress: cfg.progress });

  const re = /data-role="(section|step|hint|flag)"([^>]*)>/g;
  const marks = [];
  let m;
  while ((m = re.exec(html))) marks.push({ kind: m[1], attrs: m[2], start: m.index, end: re.lastIndex });

  const idOf = (attrs) => { const mm = /data-id="([^"]*)"/.exec(attrs); return mm ? mm[1] : ''; };
  const sliceAfter = (i) => html.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : html.length);
  const fieldVal = (s, field) => {
    const mm = new RegExp('data-field="' + field + '"[^>]*\\svalue="([^"]*)"').exec(s);
    return mm ? mm[1] : '';
  };
  const selectedOpt = (s, field) => {
    const sel = new RegExp('<select data-field="' + field + '">([\\s\\S]*?)<\\/select>').exec(s);
    if (!sel) return '';
    const opt = /<option value="([^"]*)"[^>]*selected/.exec(sel[1]);
    return opt ? opt[1] : '';
  };

  const sections = [];
  const steps = [];
  const flags = [];
  let curStep = -1;

  marks.forEach((mk, i) => {
    const s = sliceAfter(i);
    if (mk.kind === 'section') {
      const note = /<textarea data-field="note"[^>]*>([^<]*)<\/textarea>/.exec(s);
      sections.push({ id: idOf(mk.attrs), name: fieldVal(s, 'name'), note: note ? note[1] : '' });
    } else if (mk.kind === 'step') {
      const sid = selectedOpt(s, 'sectionId');
      steps.push({ id: idOf(mk.attrs), name: fieldVal(s, 'name'), sectionId: sid || null, hints: [] });
      curStep = steps.length - 1;
    } else if (mk.kind === 'hint') {
      const key = /data-field="key" data-key="([^"]*)"/.exec(s);
      const mediaRef = /data-field="mediaRef">([^<]*)<\/span>/.exec(s);
      steps[curStep].hints.push({
        id: idOf(mk.attrs),
        type: selectedOpt(s, 'type') === 'audio' ? 'audio' : 'text',
        text: fieldVal(s, 'text'),
        mediaRef: mediaRef ? mediaRef[1] : '',
        label: fieldVal(s, 'label'),
        color: fieldVal(s, 'color'),
        icon: fieldVal(s, 'icon'),
        key: key ? key[1] : '',
        countsAsClue: /data-field="countsAsClue" checked/.test(s),
      });
    } else if (mk.kind === 'flag') {
      flags.push(fieldVal(s, 'value'));
    }
  });

  const out = collectBoardConfig({ sections, steps, flags });
  assert.deepEqual(out.sections, cfg.sections);
  assert.deepEqual(out.steps, cfg.steps);
  assert.deepEqual(out.progress, cfg.progress);
});

test('renderAudioEventsCard: six rows, midShow number input, per-row picker, reflects config', () => {
  const html = renderAudioEventsCard({ audio: { events: {
    start: { file: 'intro.mp3', enabled: true },
    midShow: { enabled: true, atSecondsRemaining: 75 },
  } } });
  for (const name of AUDIO_EVENT_NAMES) {
    assert.ok(html.includes('data-name="' + name + '"'), 'missing row ' + name);
  }
  assert.match(html, /data-field="atSecondsRemaining"/);
  assert.match(html, /value="75"/);
  assert.match(html, /intro\.mp3/);
  const pickers = html.match(/data-action="pick-media"/g) || [];
  assert.equal(pickers.length, 6);
});
