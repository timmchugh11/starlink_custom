import * as THREE from './vendor/three/build/three.module.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';

const DEFAULT_REFRESH_MS = 5000;
const DEFAULT_THRESHOLD = 0.65;

class StarlinkObstructionCard extends HTMLElement {
  static getStubConfig() {
    return { title: 'Starlink', aspect_ratio: '16:9' };
  }

  setConfig(config) {
    this._config = {
      title: 'Starlink',
      aspect_ratio: '16:9',
      refresh_interval: DEFAULT_REFRESH_MS,
      obstruction_threshold: DEFAULT_THRESHOLD,
      clear_color: '#00ffff',
      obstructed_color: '#ff4444',
      desired_color: '#00D47E',
      ...config,
    };
    this._loading = false;
    this._lastLoad = 0;
    this._view = this.newViewState();
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._lastLoad || Date.now() - this._lastLoad > 1500) {
      this.loadData();
    }
  }

  connectedCallback() {
    if (!this.shadowRoot) this.render();
    this.startTimer();
    this.initScene();
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    if (this._view?.spinRaf) {
      cancelAnimationFrame(this._view.spinRaf);
      this._view.spinRaf = null;
    }
  }

  getCardSize() {
    return 4;
  }

  newViewState() {
    return {
      canvas: null,
      renderer: null,
      scene: null,
      camera: null,
      obsGroup: null,
      mapOrientGroup: null,
      yawGroup: null,
      cellMeshes: [],
      cells: [],
      dishLoadStarted: false,
      dishOrientGroup: null,
      desiredOrientGroup: null,
      _pendingAlign: null,
      yaw: 0,
      pitch: 0.5,
      zoom: 1.05,
      yawVel: 0.0003,
      baseYawVel: 0.0003,
      spinRaf: null,
      velHistory: [],
      dragging: false,
      pointerId: null,
      lastX: 0,
      lastY: 0,
    };
  }

  startTimer() {
    if (this._timer) clearInterval(this._timer);
    const refresh = Math.max(1000, Number(this._config?.refresh_interval || DEFAULT_REFRESH_MS));
    this._timer = setInterval(() => this.loadData(), refresh);
  }

  async loadData() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    try {
      const payload = await callWS(this._hass, {
        type: 'starlink/obstruction_map',
        entry_id: this._config.entry_id,
      });
      this._lastLoad = Date.now();
      this.applyPayload(payload);
    } catch (err) {
      console.error('starlink-obstruction-card loadData error:', err);
    } finally {
      this._loading = false;
    }
  }

  applyPayload(payload) {
    const view = this._view;
    const data = payload?.obstructionMap || {};
    const snr = data.snr || [];
    const rows = data.numRows || 1;
    const cols = data.numCols || Math.round(snr.length / rows);
    view.cells = [];
    let untracked = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const val = snr[r * cols + c];
        const x = ((cols - 1 - c + 0.5) / cols) * 2 - 1;
        const y = ((r + 0.5) / rows) * 2 - 1;
        const radial = x * x + y * y;
        if (radial > 1) continue;
        if (val == null || val < 0) {
          untracked++;
          continue;
        }
        view.cells.push({ x, y, z: Math.sqrt(1 - radial), value: Math.min(1, Math.max(0, val)) });
      }
    }

    if (view.scene) {
      this.buildCellMesh();
      this.renderMap();
      this.startSpin();
    }

    const threshold = Number(this._config.obstruction_threshold ?? DEFAULT_THRESHOLD);
    const obstructed = view.cells.filter((cell) => cell.value < threshold).length;
    this.setEl('st-samples', view.cells.length.toLocaleString());
    this.setEl('st-obstructed', obstructed.toLocaleString());
    this.setDisplay('obstructed-wrap', obstructed > 0 ? '' : 'none');

    const alignment = payload?.alignment || {};
    const aAz = numberOrNull(alignment.boresightAzimuthDeg);
    const aEl = numberOrNull(alignment.boresightElevationDeg);
    const dAz = numberOrNull(alignment.desiredBoresightAzimuthDeg);
    const dEl = numberOrNull(alignment.desiredBoresightElevationDeg);
    this.setEl('actual-az', aAz != null ? aAz.toFixed(1) : '-');
    this.setEl('actual-el', aEl != null ? aEl.toFixed(1) : '-');
    this.setEl('desired-az', dAz != null ? dAz.toFixed(1) : '-');
    this.setEl('desired-el', dEl != null ? dEl.toFixed(1) : '-');
    if (aAz != null && aEl != null) {
      view._pendingAlign = { aAz, aEl, dAz, dEl };
      this.applyDishOrientation(aAz, aEl);
      if (dAz != null && dEl != null) this.applyDesiredOrientation(dAz, dEl);
    }

    const status = payload?.status || {};
    const dl = status.downlinkThroughputBps != null ? (status.downlinkThroughputBps / 1e6).toFixed(2) : '-';
    const ul = status.uplinkThroughputBps != null ? (status.uplinkThroughputBps / 1e6).toFixed(2) : '-';
    const ping = status.popPingLatencyMs != null ? Math.round(status.popPingLatencyMs) : '-';
    const drop = ((status.popPingDropRate ?? 0) * 100).toFixed(1);
    this.setEl('s-dl', dl);
    this.setEl('s-ul', ul);
    this.setEl('s-ping', ping);
    this.setEl('s-drop', drop);

    const alerts = status.alerts || {};
    const hasObstruct = status.currentlyObstructed === true
      || alerts.obstructed === true
      || alerts.roofObstruction === true
      || alerts.fresnelZoneObstruction === true;
    const obstEl = this.$('s-obst-label');
    if (obstEl) {
      obstEl.className = `stat-line ${hasObstruct ? 'pill-warn' : ''}`;
      obstEl.textContent = hasObstruct ? 'Obstructed' : 'No Obstructions';
    }

    const roaming = status.roaming ?? alerts.roaming ?? false;
    const roamEl = this.$('s-roam-label');
    if (roamEl) {
      roamEl.className = `stat-line ${roaming ? 'pill-warn' : ''}`;
      roamEl.textContent = roaming ? 'Roaming' : 'Not Roaming';
    }
  }

  render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const title = this._config?.title ? `<div class="card-title">${escapeHtml(this._config.title)}</div>` : '';
    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block}
        ha-card{overflow:hidden;background:var(--ha-card-background,var(--card-background-color,#111))}
        .card-title{padding:16px 16px 0;font-size:1rem;font-weight:500;color:var(--primary-text-color)}
        #wrap{position:relative;width:100%;min-height:220px;${wrapperStyle(this._config)}}
        #canvas{width:100%;height:100%;display:block;background:transparent;touch-action:none;cursor:grab}
        #canvas.is-dragging{cursor:grabbing}
        #overlay{position:absolute;inset:0;pointer-events:none;display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr 1fr 1fr;padding:18px;gap:0}
        .stat-group{display:flex;flex-direction:column;gap:4px}
        .stat-line{font-size:14px;font-weight:500;color:rgba(255,255,255,0.88);line-height:1.35;text-shadow:0 1px 6px rgba(0,0,0,0.9);white-space:nowrap}
        .stat-line.dim{color:rgba(255,255,255,0.45);font-size:11px;font-weight:400}
        .stat-line .val{font-weight:700}
        .stat-line .unit{font-size:11px;color:rgba(255,255,255,0.5);margin-left:2px}
        .pill-ok{color:#00D47E}.pill-warn{color:#FF9500}.pill-err{color:#FF3B30}
        #stats-tl{grid-column:1;grid-row:1;align-self:start;justify-self:start}
        #stats-tr{grid-column:3;grid-row:1;align-self:start;justify-self:end;text-align:right}
        #stats-br{grid-column:3;grid-row:3;align-self:end;justify-self:end;text-align:right}
        #stats-bl{grid-column:1;grid-row:3;align-self:end;justify-self:start}
        .legend{display:flex;align-items:center;gap:8px;font-size:10px;color:rgba(255,255,255,0.35)}
        .legend-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}
        @media(prefers-color-scheme:light){
          .stat-line{color:rgba(0,0,0,0.85);text-shadow:0 1px 4px rgba(255,255,255,0.7)}
          .stat-line.dim{color:rgba(0,0,0,0.5)}
          .stat-line .unit{color:rgba(0,0,0,0.5)}
          .legend{color:rgba(0,0,0,0.45)}
        }
      </style>
      <ha-card>
        ${title}
        <div id="wrap">
          <canvas id="canvas" width="400" height="400"></canvas>
          <div id="overlay">
            <div id="stats-tl" class="stat-group">
              <div class="stat-line"><span class="val" id="s-dl">-</span><span class="unit">Mbits/s Down</span></div>
              <div class="stat-line"><span class="val" id="s-ul">-</span><span class="unit">Mbits/s Up</span></div>
              <div class="stat-line"><span class="val" id="s-ping">-</span><span class="unit">ms Ping</span></div>
            </div>
            <div id="stats-tr" class="stat-group" style="display:none">
              <div class="legend">
                <span id="legend-dot-clear" class="legend-dot" style="background:${escapeHtml(this._config.clear_color)}"></span>Clear
                <span id="legend-dot-obstructed" class="legend-dot" style="background:${escapeHtml(this._config.obstructed_color)}"></span>Obstructed
                <span class="legend-dot" style="background:${escapeHtml(this._config.desired_color)};opacity:0.6"></span>Desired
              </div>
            </div>
            <div id="stats-br" class="stat-group">
              <div class="stat-line"><span class="val" id="s-drop">-</span><span class="unit">% Dropped</span></div>
              <div class="stat-line" id="s-obst-label">-</div>
              <div class="stat-line" id="s-roam-label">-</div>
            </div>
            <div id="stats-bl" class="stat-group">
              <div class="stat-line dim">Sky: <span id="st-samples">-</span> tracked<span id="obstructed-wrap" style="display:none">, <span id="st-obstructed">-</span> blocked</span></div>
              <div class="stat-line dim">Az <span id="actual-az">-</span>deg El <span id="actual-el">-</span>deg <span style="color:rgba(255,255,255,0.3)">actual</span></div>
              <div class="stat-line dim">Az <span id="desired-az">-</span>deg El <span id="desired-el">-</span>deg <span style="color:rgba(0,212,126,0.7)">desired</span></div>
            </div>
          </div>
        </div>
      </ha-card>
    `;
    this._view.canvas = null;
    this._view.renderer = null;
    this.bindCanvas();
    this.initScene();
  }

  bindCanvas() {
    const view = this._view;
    if (view.canvas) return;
    const canvas = this.$('canvas');
    if (!canvas) return;
    view.canvas = canvas;
    canvas.addEventListener('pointerdown', (e) => {
      view.dragging = true;
      view.pointerId = e.pointerId;
      view.lastX = e.clientX;
      view.lastY = e.clientY;
      view.velHistory = [];
      canvas.classList.add('is-dragging');
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!view.dragging || e.pointerId !== view.pointerId) return;
      const dx = (e.clientX - view.lastX) * 0.01;
      view.yaw += dx;
      view.yawVel = dx;
      view.pitch = Math.max(-0.40, Math.min(1.0, view.pitch + (e.clientY - view.lastY) * 0.01));
      view.lastX = e.clientX;
      view.lastY = e.clientY;
      view.velHistory.push(dx);
      if (view.velHistory.length > 5) view.velHistory.shift();
      this.renderMap();
    });
    const endDrag = (e) => {
      if (e && view.pointerId != null && e.pointerId !== view.pointerId) return;
      view.dragging = false;
      canvas.classList.remove('is-dragging');
      if (e && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      const h = view.velHistory;
      const flick = h.length ? h.reduce((a, b) => a + b, 0) / h.length : 0;
      view.yawVel = flick;
      if (Math.abs(flick) > 0.0001) {
        const spd = Math.abs(view.baseYawVel);
        view.baseYawVel = flick > 0 ? spd : -spd;
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', (e) => {
      view.velHistory = [];
      endDrag(e);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      view.zoom = Math.max(0.3, Math.min(4.0, view.zoom * (e.deltaY > 0 ? 1.1 : 1 / 1.1)));
      this.renderMap();
    }, { passive: false });
    window.addEventListener('resize', () => this.renderMap());
  }

  initScene() {
    const view = this._view;
    this.bindCanvas();
    if (view.renderer || !view.canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas: view.canvas, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.01, 100);
    camera.position.set(0, 0.9, 2.1);
    camera.lookAt(0, 0.25, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 4, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x7ab0ff, 0.9);
    fill.position.set(-2, -1, 2);
    scene.add(fill);

    const obsGroup = new THREE.Group();
    scene.add(obsGroup);
    const mapOrientGroup = new THREE.Group();
    obsGroup.add(mapOrientGroup);
    const yawGroup = new THREE.Group();
    scene.add(yawGroup);
    this.buildCompassRing(yawGroup);
    yawGroup.scale.setScalar(0.5);

    view.renderer = renderer;
    view.scene = scene;
    view.camera = camera;
    view.obsGroup = obsGroup;
    view.mapOrientGroup = mapOrientGroup;
    view.yawGroup = yawGroup;

    const dishOrientGroup = new THREE.Group();
    obsGroup.add(dishOrientGroup);
    const desiredOrientGroup = new THREE.Group();
    desiredOrientGroup.position.y = 0.03;
    obsGroup.add(desiredOrientGroup);
    view.dishOrientGroup = dishOrientGroup;
    view.desiredOrientGroup = desiredOrientGroup;

    this.loadDishModel();
    if (view.cells.length) this.buildCellMesh();
    this.renderMap();
    this.startSpin();
  }

  loadDishModel() {
    const view = this._view;
    if (view.dishLoadStarted) return;
    view.dishLoadStarted = true;
    new GLTFLoader().load(new URL('./starlink_mini_dish.glb', import.meta.url).toString(), (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const ctr = box.getCenter(new THREE.Vector3());
      const dims = box.getSize(new THREE.Vector3());
      const scale = 0.32 / (Math.max(dims.x, dims.y, dims.z) || 1);
      model.scale.setScalar(scale);
      model.position.set(-ctr.x * scale, -ctr.y * scale + 0.04, -ctr.z * scale);
      model.traverse((child) => {
        if (!child.isMesh) return;
        child.frustumCulled = false;
        child.material = new THREE.MeshStandardMaterial({
          color: 0xe0e8f8,
          metalness: 0.3,
          roughness: 0.55,
          side: THREE.DoubleSide,
        });
      });
      view.dishOrientGroup.add(model);

      const ghost = model.clone(true);
      ghost.traverse((child) => {
        if (!child.isMesh) return;
        child.frustumCulled = false;
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(this._config.desired_color),
          metalness: 0.1,
          roughness: 0.7,
          transparent: true,
          opacity: 0.35,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
      });
      view.desiredOrientGroup.add(ghost);

      if (view._pendingAlign) {
        const { aAz, aEl, dAz, dEl } = view._pendingAlign;
        this.applyDishOrientation(aAz, aEl);
        if (dAz != null && dEl != null) this.applyDesiredOrientation(dAz, dEl);
      }
      this.renderMap();
    });
  }

  buildCompassRing(group) {
    const radius = 0.708;
    const y = 0.01;
    const pts = Array.from({ length: 129 }, (_, i) => {
      const angle = (i / 128) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    });
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }),
    ));
    for (let i = 0; i < 72; i++) {
      const angle = (i / 72) * Math.PI * 2;
      const major = i % 6 === 0;
      const r1 = radius - (major ? 0.07 : 0.03);
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(Math.cos(angle) * r1, y, Math.sin(angle) * r1),
          new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius),
        ]),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: major ? 0.75 : 0.3 }),
      ));
    }
    for (const [text, lx, lz] of [['N', 0, -0.828], ['E', 0.828, 0], ['S', 0, 0.828], ['W', -0.828, 0]]) {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const c2 = canvas.getContext('2d');
      c2.fillStyle = 'rgba(255,255,255,0.92)';
      c2.font = 'bold 88px "Segoe UI",sans-serif';
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
      c2.fillText(text, 64, 68);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
      }));
      sprite.position.set(lx, y + 0.108, lz);
      sprite.scale.set(0.156, 0.156, 1);
      group.add(sprite);
    }
  }

  buildCellMesh() {
    const view = this._view;
    if (!view.mapOrientGroup) return;
    for (const mesh of view.cellMeshes) {
      view.mapOrientGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    view.cellMeshes = [];
    if (!view.cells.length) return;

    const geometry = new THREE.BoxGeometry(0.022, 0.001, 0.022);
    const opts = { transparent: true, opacity: 0.5, depthWrite: false };
    const colors = this.getObstructionColors();
    const clearDot = this.$('legend-dot-clear');
    const obstructedDot = this.$('legend-dot-obstructed');
    if (clearDot) clearDot.style.background = colors.clear;
    if (obstructedDot) obstructedDot.style.background = colors.obstructed;
    const clear = new THREE.MeshBasicMaterial({ ...opts, color: new THREE.Color(colors.clear) });
    const blocked = new THREE.MeshBasicMaterial({ ...opts, color: new THREE.Color(colors.obstructed) });
    const dummy = new THREE.Object3D();
    const threshold = Number(this._config.obstruction_threshold ?? DEFAULT_THRESHOLD);

    for (const [subset, material] of [
      [view.cells.filter((cell) => cell.value >= threshold), clear],
      [view.cells.filter((cell) => cell.value < threshold), blocked],
    ]) {
      if (!subset.length) continue;
      const mesh = new THREE.InstancedMesh(geometry, material, subset.length);
      mesh.frustumCulled = false;
      for (let i = 0; i < subset.length; i++) {
        const { x, y, z } = subset[i];
        dummy.position.set(x, z, y);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      view.cellMeshes.push(mesh);
      view.mapOrientGroup.add(mesh);
    }
  }

  applyDishOrientation(az, el) {
    const view = this._view;
    if (!view.dishOrientGroup) return;
    const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (90 - el) * Math.PI / 180);
    const qAz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - az * Math.PI / 180);
    view.dishOrientGroup.quaternion.multiplyQuaternions(qAz, qTilt);
    if (view.mapOrientGroup) view.mapOrientGroup.quaternion.copy(qAz);
    this.renderMap();
  }

  applyDesiredOrientation(az, el) {
    const view = this._view;
    if (!view.desiredOrientGroup) return;
    const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (90 - el) * Math.PI / 180);
    const qAz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - az * Math.PI / 180);
    view.desiredOrientGroup.quaternion.multiplyQuaternions(qAz, qTilt);
    this.renderMap();
  }

  startSpin() {
    const view = this._view;
    if (view.spinRaf) return;
    const loop = () => {
      if (!view.dragging) {
        view.yawVel *= 0.92;
        view.yaw += view.yawVel + view.baseYawVel;
        if (view.yaw > Math.PI) view.yaw -= Math.PI * 2;
        else if (view.yaw < -Math.PI) view.yaw += Math.PI * 2;
        this.renderMap();
      }
      view.spinRaf = requestAnimationFrame(loop);
    };
    view.spinRaf = requestAnimationFrame(loop);
  }

  renderMap() {
    const view = this._view;
    if (!view.renderer) {
      this.initScene();
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const rect = view.canvas.parentElement.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width || 600));
    const height = Math.max(200, Math.floor(rect.height || 520));
    view.renderer.setPixelRatio(dpr);
    view.renderer.setSize(width, height, false);
    view.camera.aspect = width / height;
    view.camera.updateProjectionMatrix();
    const zoom = view.zoom;
    view.camera.position.set(0, 0.9 * zoom, 2.1 * zoom);
    view.camera.lookAt(0, 0.25, 0);
    const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), view.yaw);
    const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), view.pitch);
    const q = new THREE.Quaternion().multiplyQuaternions(qX, qY);
    if (view.obsGroup) view.obsGroup.quaternion.copy(q);
    if (view.yawGroup) view.yawGroup.quaternion.copy(q);
    view.renderer.render(view.scene, view.camera);
  }

  getObstructionColors() {
    return {
      clear: this._config.clear_color || '#00ffff',
      obstructed: this._config.obstructed_color || '#ff4444',
    };
  }

  $(id) {
    return this.shadowRoot?.getElementById(id);
  }

  setEl(id, value) {
    const el = this.$(id);
    if (el) el.textContent = value;
  }

  setDisplay(id, value) {
    const el = this.$(id);
    if (el) el.style.display = value;
  }
}

async function callWS(hass, message) {
  if (hass.callWS) return hass.callWS(message);
  return hass.connection.sendMessagePromise(message);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function wrapperStyle(config) {
  const height = normalizeCssDimension(config?.height);
  if (height) return `height:${height};`;
  return `aspect-ratio:${normalizeAspectRatio(config?.aspect_ratio)};`;
}

function normalizeCssDimension(value) {
  if (value == null || value === '') return '';
  const str = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return `${str}px`;
  if (/^\d+(\.\d+)?(px|rem|em|vh|vw|%)$/.test(str)) return str;
  throw new Error(`Invalid height value: ${str}`);
}

function normalizeAspectRatio(value) {
  const str = String(value || '16:9').trim();
  if (/^\d+(\.\d+)?\s*:\s*\d+(\.\d+)?$/.test(str)) return str.replace(':', ' / ');
  if (/^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(str)) return str;
  return '16 / 9';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

if (!customElements.get('starlink-obstruction-card')) {
  customElements.define('starlink-obstruction-card', StarlinkObstructionCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'starlink-obstruction-card',
  name: 'Starlink Obstruction Card',
  description: 'Native Starlink obstruction map and dish alignment card.',
});
