// MarkersManagerGump — local list of named map markers the player has
// pinned to the world map. Pure client-side feature (no server packet);
// markers persist via ProfileManager so they survive reload.
//
// Layout: scroll list of `{name, x, y, map, color}` rows; each row has
// "GoTo" + "Delete" buttons. "GoTo" emits `marker:goto` on the bus so
// the WorldmapGump can recenter.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { TextInput } from '../controls/text-input.js';
import { Button, ButtonAction } from '../controls/button.js';
import { profile } from '../../managers/profile-manager.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';

const KEY = 'markers';

function loadMarkers() {
  return profile.get(`ui.${KEY}`) ?? [];
}
function saveMarkers(markers) {
  profile.set(`ui.${KEY}`, markers);
}

export class MarkersManagerGump extends WindowGump {
  constructor() {
    super({ title: 'Map Markers', width: 360, height: 360, x: 220, y: 140 });
    this.markers = loadMarkers();

    this._scroll = new ScrollArea({ width: 336, height: 220 });
    this.addContent(this._scroll, 12, 30);

    this._addName = new TextInput({ width: 200, height: 22, maxLength: 30, placeholder: 'Name' });
    this.addContent(this._addName, 12, 260);
    const addHere = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 100, height: 22, label: 'Add Here', action: ButtonAction.Activate,
    });
    addHere.setPosition(220, 260);
    addHere.onClick = () => this._addAtPlayer();
    this.add(addHere);

    // Audit #46 P2 — CSV import / export + party-share. CUO has
    // dedicated buttons for these on `MarkersManagerGump.cs`. We expose
    // them as compact DOM prompts so the user can paste a CSV blob.
    const importBtn = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 70, height: 18, label: 'CSV Imp', action: ButtonAction.Activate,
    });
    importBtn.setPosition(12, 292);
    importBtn.onClick = () => this._importCsv();
    this.add(importBtn);

    const exportBtn = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 70, height: 18, label: 'CSV Exp', action: ButtonAction.Activate,
    });
    exportBtn.setPosition(88, 292);
    exportBtn.onClick = () => this._exportCsv();
    this.add(exportBtn);

    const partyShare = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 90, height: 18, label: 'Share Party', action: ButtonAction.Activate,
    });
    partyShare.setPosition(164, 292);
    partyShare.onClick = () => this._shareToParty();
    this.add(partyShare);

    const fetchUrl = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 80, height: 18, label: 'Fetch URL', action: ButtonAction.Activate,
    });
    fetchUrl.setPosition(258, 292);
    fetchUrl.onClick = () => this._fetchFromUrl();
    this.add(fetchUrl);

    this._renderList();
  }

  _importCsv() {
    const csv = window.prompt?.('Paste CSV (name,x,y,map,hue per line):', '');
    if (!csv) return;
    const lines = String(csv).split(/\r?\n/);
    let added = 0;
    for (const line of lines) {
      const cells = line.split(',').map((s) => s.trim());
      if (cells.length < 3) continue;
      const m = {
        name: cells[0], x: parseInt(cells[1], 10) | 0, y: parseInt(cells[2], 10) | 0,
        map: parseInt(cells[3] ?? '0', 10) | 0,
        color: parseInt(cells[4] ?? 'fff0c0', 16) | 0,
      };
      if (!m.name || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      this.markers.push(m);
      added++;
    }
    if (added) {
      saveMarkers(this.markers);
      this._renderList();
      bus.emit('marker:imported', { count: added });
    }
  }

  _exportCsv() {
    const lines = this.markers.map((m) =>
      `${m.name},${m.x},${m.y},${m.map ?? 0},${(m.color | 0).toString(16)}`);
    window.prompt?.('Copy CSV:', lines.join('\n'));
  }

  _shareToParty() {
    // Broadcast marker list to party via dedicated bus event — chat
    // manager / partyManager subscribes and dispatches a chat message.
    bus.emit('marker:party-share', { markers: this.markers });
  }

  async _fetchFromUrl() {
    const url = window.prompt?.('External markers JSON URL:', profile.get('worldmap.extMarkersUrl') ?? '');
    if (!url) return;
    try {
      const res = await fetch(url);
      const list = await res.json();
      if (!Array.isArray(list)) throw new Error('expected array');
      let added = 0;
      for (const m of list) {
        if (!m?.name || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
        this.markers.push({ ...m, color: m.color ?? 0xfff0c0 });
        added++;
      }
      saveMarkers(this.markers);
      this._renderList();
      profile.set('worldmap.extMarkersUrl', url);
      bus.emit('marker:imported', { count: added, source: url });
    } catch (e) {
      window.alert?.(`Marker fetch failed: ${e?.message}`);
    }
  }

  get type() { return 'markers-manager'; }
  get positionKey() { return 'markers-manager'; }

  _addAtPlayer() {
    const name = this._addName.value.trim();
    if (!name || !world.player) return;
    const marker = {
      name, x: world.player.x, y: world.player.y,
      map: world.mapId, color: 0xfff0c0,
    };
    this.markers.push(marker);
    saveMarkers(this.markers);
    this._addName.setValue('');
    this._renderList();
    bus.emit('marker:added', marker);
  }

  _renderList() {
    if (this._rows) for (const r of this._rows) r.dispose?.();
    this._rows = [];
    let y = 0;
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i];
      const row = new Label(`${m.name} (${m.x}, ${m.y}) [map ${m.map}]`,
        { fontSize: 11, hue: m.color });
      row.setPosition(0, y);
      this._scroll.add(row);
      this._rows.push(row);

      const goTo = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 50, height: 18, label: 'Go', action: ButtonAction.Activate,
      });
      goTo.setPosition(220, y);
      goTo.onClick = () => bus.emit('marker:goto', m);
      this._scroll.add(goTo);
      this._rows.push(goTo);

      const del = new Button({
        normalGumpId: 0x0483, pressedGumpId: 0x0484,
        width: 50, height: 18, label: 'Del', action: ButtonAction.Activate,
      });
      del.setPosition(280, y);
      del.onClick = () => {
        this.markers.splice(i, 1);
        saveMarkers(this.markers);
        this._renderList();
      };
      this._scroll.add(del);
      this._rows.push(del);

      y += 22;
    }
    this._scroll.setContentSize?.(320, y);
  }
}
