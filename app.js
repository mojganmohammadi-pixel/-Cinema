'use strict';

class CinemaApp {
  constructor() {
    this.canvas = document.getElementById('preview-canvas');
    this.ctx    = this.canvas.getContext('2d');
    this.canvas.width  = 1280;
    this.canvas.height = 720;

    this.scenes        = [];
    this.mediaFiles    = new Map(); // id → { id, name, type, url, element }
    this.thumbnails    = new Map(); // sceneId → <canvas>

    this.isPlaying     = false;
    this.playPosition  = 0;   // seconds from start
    this.lastFrameTime = null;

    this.selectedSceneId = null;
    this.editingTextId   = null;

    this.isExporting     = false;
    this.recorder        = null;
    this.recordedChunks  = [];

    const first = this._createScene();
    first.texts.push(this._defaultText('Cinema', 64, 0.5, 0.45));
    first.texts.push(this._defaultText('Your story begins here', 28, 0.5, 0.58, '#aaaacc', false));
    this.scenes.push(first);
    this.selectedSceneId = first.id;

    this._bindEvents();
    this._renderTimeline();
    this._renderProperties();
    this._startRenderLoop();
  }

  // ── Scene / text factories ──────────────────────────────────

  _createScene(mediaId = null) {
    return {
      id: crypto.randomUUID(),
      duration: 4,
      background: mediaId
        ? { type: 'media', id: mediaId }
        : { type: 'color', value: '#0d0d1e' },
      texts: [],
      transition: 'fade',
    };
  }

  _defaultText(content, size, x, y, color = '#ffffff', bold = true) {
    return {
      id: crypto.randomUUID(),
      content,
      font: "Georgia, 'Times New Roman', serif",
      size,
      color,
      x,
      y,
      align: 'center',
      bold,
      shadow: true,
      animation: 'fade',
    };
  }

  // ── Computed helpers ────────────────────────────────────────

  get totalDuration() {
    return this.scenes.reduce((s, sc) => s + sc.duration, 0);
  }

  get selectedScene() {
    return this.scenes.find(s => s.id === this.selectedSceneId) || null;
  }

  _getSceneAtTime(t) {
    let elapsed = 0;
    for (const scene of this.scenes) {
      if (t < elapsed + scene.duration) {
        return { scene, localTime: t - elapsed, sceneStart: elapsed };
      }
      elapsed += scene.duration;
    }
    const last = this.scenes[this.scenes.length - 1];
    return last
      ? { scene: last, localTime: last.duration, sceneStart: elapsed - last.duration }
      : null;
  }

  _getSceneStart(id) {
    let elapsed = 0;
    for (const scene of this.scenes) {
      if (scene.id === id) return elapsed;
      elapsed += scene.duration;
    }
    return 0;
  }

  // ── Scene management ────────────────────────────────────────

  _addScene(mediaId = null) {
    const scene = this._createScene(mediaId);
    this.scenes.push(scene);
    this.selectedSceneId = scene.id;
    this._renderTimeline();
    this._renderProperties();
    return scene;
  }

  _deleteScene(id) {
    if (this.scenes.length <= 1) return;
    const idx = this.scenes.findIndex(s => s.id === id);
    this.scenes.splice(idx, 1);
    if (this.selectedSceneId === id) {
      this.selectedSceneId = this.scenes[Math.max(0, idx - 1)]?.id || null;
    }
    this._renderTimeline();
    this._renderProperties();
  }

  // ── Media management ────────────────────────────────────────

  async _addMedia(file) {
    return new Promise(resolve => {
      const id  = crypto.randomUUID();
      const url = URL.createObjectURL(file);
      const isVideo = file.type.startsWith('video/');

      if (isVideo) {
        const video = document.createElement('video');
        video.src     = url;
        video.muted   = true;
        video.preload = 'auto';
        video.onloadeddata = () => {
          this.mediaFiles.set(id, { id, name: file.name, type: 'video', url, element: video });
          this._renderMediaGrid();
          resolve(id);
        };
        video.onerror = () => resolve(null);
      } else {
        const img = new Image();
        img.onload = () => {
          this.mediaFiles.set(id, { id, name: file.name, type: 'image', url, element: img });
          this._renderMediaGrid();
          resolve(id);
        };
        img.onerror = () => resolve(null);
        img.src = url;
      }
    });
  }

  // ── Rendering ───────────────────────────────────────────────

  _startRenderLoop() {
    const loop = ts => {
      if (this.isPlaying && this.lastFrameTime !== null) {
        const delta = (ts - this.lastFrameTime) / 1000;
        this.playPosition = Math.min(this.playPosition + delta, this.totalDuration);
        if (this.playPosition >= this.totalDuration) this._stopPlayback();
        this._updateProgress();
      }
      this.lastFrameTime = this.isPlaying ? ts : null;

      this._drawFrame(this.playPosition);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  _drawFrame(t) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    if (this.scenes.length === 0) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      return;
    }

    const info = this._getSceneAtTime(t);
    if (!info) return;

    const { scene, localTime } = info;
    const TR = 0.35; // transition duration (seconds)

    this._drawBackground(scene);
    for (const text of scene.texts) this._drawText(text, localTime, scene.duration);

    // Fade-in from black at scene start (except first scene)
    if (localTime < TR && this.scenes[0] !== scene) {
      ctx.fillStyle = `rgba(0,0,0,${1 - localTime / TR})`;
      ctx.fillRect(0, 0, W, H);
    }

    // Fade-out to black at scene end (except last scene)
    const left = scene.duration - localTime;
    const sceneIdx = this.scenes.indexOf(scene);
    if (left < TR && sceneIdx < this.scenes.length - 1) {
      ctx.fillStyle = `rgba(0,0,0,${1 - left / TR})`;
      ctx.fillRect(0, 0, W, H);
    }

    // Selection outline in edit mode
    if (!this.isPlaying && !this.isExporting && scene.id === this.selectedSceneId) {
      ctx.strokeStyle = 'rgba(201,168,76,.35)';
      ctx.lineWidth = 5;
      ctx.strokeRect(2.5, 2.5, W - 5, H - 5);
    }
  }

  _drawBackground(scene) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;

    if (scene.background.type === 'color') {
      ctx.fillStyle = scene.background.value;
      ctx.fillRect(0, 0, W, H);
      return;
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (scene.background.type === 'media') {
      const media = this.mediaFiles.get(scene.background.id);
      if (!media) return;
      const el   = media.element;
      const srcW = media.type === 'video' ? el.videoWidth  : el.naturalWidth;
      const srcH = media.type === 'video' ? el.videoHeight : el.naturalHeight;
      if (!srcW || !srcH) return;
      const scale = Math.max(W / srcW, H / srcH);
      const dw = srcW * scale, dh = srcH * scale;
      ctx.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
  }

  _drawText(text, localTime, sceneDuration) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const ANIM = 0.4;

    let alpha = 1;
    if (text.animation !== 'none') {
      if (localTime < ANIM) alpha = localTime / ANIM;
      else if (localTime > sceneDuration - ANIM) alpha = (sceneDuration - localTime) / ANIM;
      alpha = Math.max(0, Math.min(1, alpha));
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    const px = text.size * (W / 1280);
    ctx.font = `${text.bold ? 'bold' : 'normal'} ${px}px ${text.font}`;
    ctx.fillStyle  = text.color;
    ctx.textAlign  = text.align || 'center';
    ctx.textBaseline = 'middle';

    if (text.shadow) {
      ctx.shadowColor   = 'rgba(0,0,0,.85)';
      ctx.shadowBlur    = 10;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
    }

    const lines = text.content.split('\n');
    const lh    = px * 1.35;
    const totalH = lines.length * lh;
    const bx = text.x * W;
    const by = text.y * H;

    lines.forEach((line, i) => {
      ctx.fillText(line, bx, by - totalH / 2 + i * lh + lh / 2);
    });

    ctx.restore();
  }

  // ── Thumbnail helpers ────────────────────────────────────────

  _updateThumbnail(sceneId) {
    const scene = this.scenes.find(s => s.id === sceneId);
    const thumb = this.thumbnails.get(sceneId);
    if (!scene || !thumb) return;

    const tc = thumb.getContext('2d');
    const W = thumb.width, H = thumb.height;
    tc.clearRect(0, 0, W, H);

    if (scene.background.type === 'color') {
      tc.fillStyle = scene.background.value;
      tc.fillRect(0, 0, W, H);
    } else if (scene.background.type === 'media') {
      tc.fillStyle = '#000';
      tc.fillRect(0, 0, W, H);
      const media = this.mediaFiles.get(scene.background.id);
      if (media) {
        const el   = media.element;
        const srcW = media.type === 'video' ? el.videoWidth  : el.naturalWidth;
        const srcH = media.type === 'video' ? el.videoHeight : el.naturalHeight;
        if (srcW && srcH) {
          const scale = Math.max(W / srcW, H / srcH);
          const dw = srcW * scale, dh = srcH * scale;
          tc.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh);
        }
      }
    }

    if (scene.texts.length > 0) {
      const t  = scene.texts[0];
      const px = Math.max(8, Math.round(t.size * W / 1280));
      tc.save();
      tc.font = `bold ${px}px ${t.font}`;
      tc.fillStyle = t.color;
      tc.textAlign = 'center';
      tc.textBaseline = 'middle';
      tc.shadowColor = 'rgba(0,0,0,.8)';
      tc.shadowBlur  = 4;
      tc.fillText(t.content.split('\n')[0], W / 2, H / 2);
      tc.restore();
    }
  }

  // ── UI — media grid ─────────────────────────────────────────

  _renderMediaGrid() {
    const grid = document.getElementById('media-grid');
    grid.innerHTML = '';

    for (const [id, media] of this.mediaFiles) {
      const item = document.createElement('div');
      item.className = 'media-item';

      const el = media.type === 'image'
        ? Object.assign(document.createElement('img'),  { src: media.url })
        : Object.assign(document.createElement('video'), { src: media.url, muted: true });
      item.appendChild(el);

      const badge = document.createElement('div');
      badge.className = 'media-badge';
      badge.textContent = media.type === 'video' ? '▶ video' : '🖼 img';
      item.appendChild(badge);

      const plus = document.createElement('div');
      plus.className = 'media-add';
      plus.textContent = '+';
      item.appendChild(plus);

      item.addEventListener('click', () => {
        if (this.selectedScene) {
          this.selectedScene.background = { type: 'media', id };
          this._updateThumbnail(this.selectedSceneId);
          this._renderTimeline();
          this._renderProperties();
        } else {
          this._addScene(id);
        }
      });

      grid.appendChild(item);
    }
  }

  // ── UI — timeline ───────────────────────────────────────────

  _renderTimeline() {
    const track = document.getElementById('scenes-track');
    track.innerHTML = '';

    for (const scene of this.scenes) {
      // Ensure thumbnail canvas exists
      if (!this.thumbnails.has(scene.id)) {
        const c = document.createElement('canvas');
        c.width  = 160;
        c.height = 90;
        this.thumbnails.set(scene.id, c);
      }
      this._updateThumbnail(scene.id);

      const card = document.createElement('div');
      card.className = 'scene-card' + (scene.id === this.selectedSceneId ? ' selected' : '');
      const w = Math.max(80, Math.min(180, scene.duration * 28));
      card.style.width = w + 'px';

      // Thumbnail
      const thumb = this.thumbnails.get(scene.id);
      thumb.className = 'scene-thumb';
      card.appendChild(thumb);

      // Footer
      const footer = document.createElement('div');
      footer.className = 'scene-footer';

      const lbl = document.createElement('span');
      lbl.textContent = `${this.scenes.indexOf(scene) + 1}  ·  ${scene.duration}s`;
      footer.appendChild(lbl);

      if (this.scenes.length > 1) {
        const del = document.createElement('button');
        del.className = 'scene-del';
        del.title     = 'Delete scene';
        del.textContent = '×';
        del.addEventListener('click', e => { e.stopPropagation(); this._deleteScene(scene.id); });
        footer.appendChild(del);
      }

      card.appendChild(footer);

      card.addEventListener('click', () => {
        this.selectedSceneId = scene.id;
        this.playPosition    = this._getSceneStart(scene.id);
        this._renderTimeline();
        this._renderProperties();
        this._updateProgress();
      });

      track.appendChild(card);
    }
  }

  // ── UI — properties panel ───────────────────────────────────

  _renderProperties() {
    const content = document.getElementById('properties-content');
    content.innerHTML = '';
    const scene = this.selectedScene;

    if (!scene) {
      content.innerHTML = '<div class="no-selection">Select a scene to edit</div>';
      return;
    }

    // Duration
    const durGroup = this._propGroup('Duration');
    const durRow = document.createElement('div');
    durRow.className = 'prop-row';
    const durInput = Object.assign(document.createElement('input'), {
      type: 'number', min: 1, max: 60, step: 0.5, value: scene.duration,
    });
    durInput.addEventListener('change', () => {
      scene.duration = Math.max(1, parseFloat(durInput.value) || 4);
      this._renderTimeline();
      this._updateProgress();
    });
    const durUnit = document.createElement('span');
    durUnit.textContent = 'sec';
    durUnit.style.cssText = 'color:#555568;white-space:nowrap';
    durRow.append(durInput, durUnit);
    durGroup.appendChild(durRow);
    content.appendChild(durGroup);

    // Background
    const bgGroup = this._propGroup('Background');

    const bgSel = document.createElement('select');
    bgSel.innerHTML = `
      <option value="color" ${scene.background.type === 'color' ? 'selected' : ''}>Solid Color</option>
      <option value="media" ${scene.background.type === 'media' ? 'selected' : ''}>Media (from library)</option>
    `;
    bgGroup.appendChild(bgSel);

    const colorRow = document.createElement('div');
    colorRow.className = 'prop-row';
    const colorInput = Object.assign(document.createElement('input'), {
      type: 'color', value: scene.background.value || '#0d0d1e',
    });
    colorInput.style.display = scene.background.type === 'color' ? '' : 'none';
    colorInput.addEventListener('input', () => {
      scene.background.value = colorInput.value;
      this._updateThumbnail(scene.id);
      this._renderTimeline();
    });
    colorRow.appendChild(colorInput);
    bgGroup.appendChild(colorRow);

    const mediaHint = document.createElement('div');
    mediaHint.style.cssText = 'color:#555568;font-size:11px;margin-top:4px';
    const updateHint = () => {
      if (scene.background.type === 'media') {
        const name = this.mediaFiles.get(scene.background.id)?.name;
        mediaHint.textContent = name ? `Using: ${name}` : 'Click a media item to assign';
        mediaHint.style.display = '';
        colorRow.style.display  = 'none';
      } else {
        mediaHint.style.display = 'none';
        colorRow.style.display  = '';
      }
    };
    updateHint();
    bgGroup.appendChild(mediaHint);

    bgSel.addEventListener('change', () => {
      scene.background = bgSel.value === 'color'
        ? { type: 'color', value: colorInput.value }
        : { type: 'media', id: null };
      updateHint();
      this._updateThumbnail(scene.id);
      this._renderTimeline();
    });

    content.appendChild(bgGroup);

    // Divider
    const div = document.createElement('div');
    div.className = 'divider';
    content.appendChild(div);

    // Text overlays
    const textGroup = this._propGroup('Text Overlays');

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm';
    addBtn.textContent = '+ Add Text';
    addBtn.style.width = '100%';
    addBtn.addEventListener('click', () => {
      scene.texts.push(this._defaultText('New Text', 48, 0.5, 0.5));
      this._renderProperties();
      this._updateThumbnail(scene.id);
    });
    textGroup.appendChild(addBtn);

    for (const text of scene.texts) {
      textGroup.appendChild(this._buildTextItem(scene, text));
    }

    content.appendChild(textGroup);
  }

  _buildTextItem(scene, text) {
    const wrapper = document.createElement('div');
    wrapper.style.marginTop = '7px';

    // Header row
    const header = document.createElement('div');
    header.className = 'overlay-item';

    const preview = document.createElement('span');
    preview.className = 'overlay-preview';
    preview.textContent = text.content;
    preview.style.color = text.color;

    const editBtn = Object.assign(document.createElement('button'), { className: 'icon-btn', title: 'Edit' });
    editBtn.textContent = '✏';

    const delBtn = Object.assign(document.createElement('button'), { className: 'icon-btn danger', title: 'Delete' });
    delBtn.textContent = '×';
    delBtn.addEventListener('click', () => {
      scene.texts = scene.texts.filter(t => t.id !== text.id);
      this._updateThumbnail(scene.id);
      this._renderProperties();
    });

    header.append(preview, editBtn, delBtn);
    wrapper.appendChild(header);

    // Collapsible edit form
    const form = document.createElement('div');
    form.className = 'text-edit-form';
    form.style.display = this.editingTextId === text.id ? 'flex' : 'none';

    editBtn.addEventListener('click', () => {
      this.editingTextId = this.editingTextId === text.id ? null : text.id;
      form.style.display = this.editingTextId === text.id ? 'flex' : 'none';
    });

    // Content
    this._field(form, 'Text content', () => {
      const ta = document.createElement('textarea');
      ta.value = text.content;
      ta.style.background = 'var(--bg-dark)';
      ta.addEventListener('input', () => {
        text.content = ta.value;
        preview.textContent = ta.value;
        this._updateThumbnail(scene.id);
      });
      return ta;
    });

    // Font
    this._field(form, 'Font', () => {
      const sel = document.createElement('select');
      [
        ["Georgia, 'Times New Roman', serif", 'Georgia'],
        ["'Palatino Linotype', serif",         'Palatino'],
        ["-apple-system, sans-serif",           'System'],
        ["Arial, sans-serif",                   'Arial'],
        ["Impact, sans-serif",                  'Impact'],
        ["'Courier New', monospace",            'Courier New'],
      ].forEach(([val, lbl]) => {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = lbl;
        if (text.font === val) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => { text.font = sel.value; });
      return sel;
    });

    // Size
    this._field(form, 'Size', () => {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const inp = Object.assign(document.createElement('input'),
        { type: 'range', min: 12, max: 200, value: text.size });
      const val = document.createElement('span');
      val.textContent = text.size + 'px';
      val.style.cssText = 'min-width:36px;text-align:right;color:#555568;font-size:11px';
      inp.addEventListener('input', () => { text.size = +inp.value; val.textContent = inp.value + 'px'; });
      row.append(inp, val);
      return row;
    });

    // Color
    this._field(form, 'Color', () => {
      const inp = Object.assign(document.createElement('input'),
        { type: 'color', value: text.color });
      inp.addEventListener('input', () => {
        text.color = inp.value;
        preview.style.color = inp.value;
      });
      return inp;
    });

    // Position X
    this._field(form, 'Horizontal position', () => {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const inp = Object.assign(document.createElement('input'),
        { type: 'range', min: 0, max: 100, value: Math.round(text.x * 100) });
      const val = document.createElement('span');
      val.textContent = Math.round(text.x * 100) + '%';
      val.style.cssText = 'min-width:34px;text-align:right;color:#555568;font-size:11px';
      inp.addEventListener('input', () => { text.x = +inp.value / 100; val.textContent = inp.value + '%'; });
      row.append(inp, val);
      return row;
    });

    // Position Y
    this._field(form, 'Vertical position', () => {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const inp = Object.assign(document.createElement('input'),
        { type: 'range', min: 0, max: 100, value: Math.round(text.y * 100) });
      const val = document.createElement('span');
      val.textContent = Math.round(text.y * 100) + '%';
      val.style.cssText = 'min-width:34px;text-align:right;color:#555568;font-size:11px';
      inp.addEventListener('input', () => { text.y = +inp.value / 100; val.textContent = inp.value + '%'; });
      row.append(inp, val);
      return row;
    });

    // Style toggles
    this._field(form, 'Style', () => {
      const row = document.createElement('div');
      row.className = 'prop-row';
      row.style.gap = '14px';

      const boldLbl = document.createElement('label');
      const boldCb  = Object.assign(document.createElement('input'), { type: 'checkbox', checked: text.bold });
      boldCb.addEventListener('change', () => { text.bold = boldCb.checked; });
      boldLbl.append(boldCb, 'Bold');

      const shadLbl = document.createElement('label');
      const shadCb  = Object.assign(document.createElement('input'), { type: 'checkbox', checked: text.shadow });
      shadCb.addEventListener('change', () => { text.shadow = shadCb.checked; });
      shadLbl.append(shadCb, 'Shadow');

      row.append(boldLbl, shadLbl);
      return row;
    });

    wrapper.appendChild(form);
    return wrapper;
  }

  _field(parent, label, createEl) {
    const wrap = document.createElement('div');
    wrap.className = 'form-field';
    const lbl = document.createElement('div');
    lbl.className = 'form-field-label';
    lbl.textContent = label;
    wrap.append(lbl, createEl());
    parent.appendChild(wrap);
  }

  _propGroup(title) {
    const g = document.createElement('div');
    g.className = 'prop-group';
    const lbl = document.createElement('div');
    lbl.className = 'prop-label';
    lbl.textContent = title;
    g.appendChild(lbl);
    return g;
  }

  // ── Playback ─────────────────────────────────────────────────

  _togglePlayback() {
    if (this.isPlaying) {
      this._stopPlayback();
    } else {
      if (this.playPosition >= this.totalDuration) this.playPosition = 0;
      this.isPlaying     = true;
      this.lastFrameTime = null;
      document.getElementById('btn-play').textContent = '⏸';
      this._syncVideos();
    }
  }

  _stopPlayback() {
    this.isPlaying = false;
    document.getElementById('btn-play').textContent = '▶';
    for (const [, m] of this.mediaFiles) {
      if (m.type === 'video') m.element.pause();
    }
  }

  _syncVideos() {
    if (!this.isPlaying) return;
    const info = this._getSceneAtTime(this.playPosition);
    if (!info) return;
    const { scene, localTime } = info;
    if (scene.background.type === 'media') {
      const media = this.mediaFiles.get(scene.background.id);
      if (media?.type === 'video') {
        media.element.currentTime = localTime % (media.element.duration || Infinity);
        media.element.play().catch(() => {});
      }
    }
  }

  _updateProgress() {
    const total = this.totalDuration;
    const pct   = total > 0 ? (this.playPosition / total) * 100 : 0;
    document.getElementById('progress-fill').style.width  = pct + '%';
    document.getElementById('progress-handle').style.left = pct + '%';
    const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    document.getElementById('time-display').textContent = `${fmt(this.playPosition)} / ${fmt(total)}`;
  }

  _prevScene() {
    const idx = this.scenes.findIndex(s => s.id === this.selectedSceneId);
    if (idx > 0) {
      this.selectedSceneId = this.scenes[idx - 1].id;
      this.playPosition    = this._getSceneStart(this.selectedSceneId);
      this._renderTimeline();
      this._renderProperties();
      this._updateProgress();
    }
  }

  _nextScene() {
    const idx = this.scenes.findIndex(s => s.id === this.selectedSceneId);
    if (idx < this.scenes.length - 1) {
      this.selectedSceneId = this.scenes[idx + 1].id;
      this.playPosition    = this._getSceneStart(this.selectedSceneId);
      this._renderTimeline();
      this._renderProperties();
      this._updateProgress();
    }
  }

  // ── Export ───────────────────────────────────────────────────

  async _exportVideo() {
    if (this.isExporting || this.scenes.length === 0) return;

    if (!window.MediaRecorder) {
      alert('MediaRecorder is not supported in this browser. Try Chrome or Firefox.');
      return;
    }

    this.isExporting = true;
    this._stopPlayback();
    this.playPosition = 0;
    this._updateProgress();

    document.getElementById('export-overlay').classList.remove('hidden');
    document.getElementById('btn-export').disabled = true;

    const stream   = this.canvas.captureStream(30);
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

    this.recordedChunks = [];
    this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });

    this.recorder.ondataavailable = e => { if (e.data.size > 0) this.recordedChunks.push(e.data); };

    this.recorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: mimeType });
      const a    = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(blob),
        download: 'cinema-export.webm',
      });
      a.click();
      URL.revokeObjectURL(a.href);

      this.isExporting = false;
      document.getElementById('export-overlay').classList.add('hidden');
      document.getElementById('btn-export').disabled = false;
      this.recorder = null;
    };

    this.recorder.start(100);

    // Drive playback for recording
    this.isPlaying     = true;
    this.lastFrameTime = null;
    this._syncVideos();

    // Wait until playback finishes
    await new Promise(resolve => {
      const check = () => {
        if (!this.isPlaying || this.playPosition >= this.totalDuration) {
          resolve();
        } else {
          setTimeout(check, 200);
        }
      };
      setTimeout(check, 200);
    });

    this._stopPlayback();
    this.recorder?.stop();
  }

  // ── Event binding ─────────────────────────────────────────────

  _bindEvents() {
    // File input
    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', async e => {
      for (const file of e.target.files) await this._addMedia(file);
      fileInput.value = '';
    });

    // Drag-and-drop on upload zone
    const zone = document.getElementById('upload-zone');
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      for (const file of e.dataTransfer.files) {
        if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
          await this._addMedia(file);
        }
      }
    });

    // Playback controls
    document.getElementById('btn-play').addEventListener('click', () => this._togglePlayback());
    document.getElementById('btn-prev').addEventListener('click', () => this._prevScene());
    document.getElementById('btn-next').addEventListener('click', () => this._nextScene());

    // Progress bar scrub
    const pb = document.getElementById('progress-bar');
    pb.addEventListener('click', e => {
      const rect = pb.getBoundingClientRect();
      this.playPosition = ((e.clientX - rect.left) / rect.width) * this.totalDuration;
      this._updateProgress();
      if (this.isPlaying) this._syncVideos();
    });

    // Add scene
    document.getElementById('btn-add-scene').addEventListener('click', () => this._addScene());

    // Export
    document.getElementById('btn-export').addEventListener('click', () => this._exportVideo());

    // Spacebar to play/pause
    document.addEventListener('keydown', e => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); this._togglePlayback(); }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new CinemaApp(); });
