import type { BuildingRecord, PalaceData, Quality, UIActions } from './types';

const icons = {
  overview: '<path d="M3 10.5 12 3l9 7.5M5.5 9v11h13V9M9 20v-7h6v7"/>',
  top: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  walk: '<circle cx="13" cy="4.5" r="2"/><path d="m10 10 3-3 3 5 4 1M5 14l5-4 2 5-4 6M12 15l5 6"/>',
  label: '<path d="M4 5h12l5 7-5 7H4V5Z"/><circle cx="8" cy="12" r="1.4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
};

function icon(name: keyof typeof icons): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
}
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
function named(record: BuildingRecord): boolean {
  return Boolean(record.landmark) || Boolean(record.name && !/^(?:未命名|无名|附属建筑|建筑[\s·#\d]|OSM|Building)/i.test(record.name));
}

export function createUI(data: PalaceData, actions: UIActions): {
  select(id: string | null): void;
  stats(fps: number, draws: number, triangles: number): void;
  walking(active: boolean): void;
  loading(progress: number, text: string): void;
  setLabels(visible: boolean): void;
} {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  const records = new Map(data.buildings.map((building) => [building.id, building]));
  const zones = [...new Set(data.buildings.filter(named).map((building) => building.zone))];
  const featuredOrder = ['午门', '太和殿', '中和殿', '保和殿', '乾清宫', '坤宁宫', '钦安殿', '皇极殿', '角楼'];
  const landmarkRank = (building: BuildingRecord) => {
    const rank = featuredOrder.findIndex((name) => building.name.includes(name));
    return rank < 0 ? 99 : rank;
  };
  const landmarks = data.buildings.filter((building) => building.landmark).sort((a, b) => landmarkRank(a) - landmarkRank(b));
  let selected: string | null = null;
  let zone = '全部';
  let query = '';
  let showAll = false;
  let labelsVisible = true;
  let walking = false;
  let navOpen = window.innerWidth >= 900;
  let completionTimer: number | undefined;

  const boundsPoints = [...data.boundary, ...data.buildings.flatMap((building) => building.footprint)];
  const minX = Math.min(...boundsPoints.map((point) => point[0]));
  const maxX = Math.max(...boundsPoints.map((point) => point[0]));
  const minZ = Math.min(...boundsPoints.map((point) => point[1]));
  const maxZ = Math.max(...boundsPoints.map((point) => point[1]));
  const padding = 22;
  const viewbox = `${minX - padding} ${minZ - padding} ${maxX - minX + padding * 2} ${maxZ - minZ + padding * 2}`;
  const points = (vertices: [number, number][]) => vertices.map((point) => point.join(',')).join(' ');

  app.innerHTML = `
    <main id="scene" aria-label="北京故宫三维模型"></main>
    <div class="screen-grain" aria-hidden="true"></div>
    <header class="masthead">
      <div class="identity"><span class="seal" aria-hidden="true">紫<br>禁</span><div><p class="eyebrow">THE FORBIDDEN CITY · BEIJING</p><h1>北京<span>·</span>故宫</h1><p class="identity-caption">宫城建筑 · 三维览胜</p></div></div>
      <button class="nav-toggle" id="nav-toggle" type="button" aria-controls="building-nav" aria-expanded="${navOpen}">${icon('menu')}<span>建筑导览</span></button>
    </header>
    <section class="landmark-strip" aria-label="精选建筑">
      <span class="landmark-heading">宫城地标</span>
      <div class="landmark-chips">${landmarks.slice(0, 9).map((building) => `<button type="button" data-pick="${esc(building.id)}" title="定位${esc(building.name)}">${esc(building.name)}</button>`).join('')}</div>
    </section>
    <aside class="building-nav" id="building-nav" aria-label="建筑导览">
      <div class="nav-heading"><div><span class="eyebrow">PALACE DIRECTORY</span><h2>建筑导览</h2></div><button class="icon-button" type="button" id="nav-close" aria-label="收起建筑导览">${icon('close')}</button></div>
      <div class="directory">
        <label class="search-field">${icon('search')}<input id="building-search" type="search" placeholder="搜索宫殿、宫门、院落" autocomplete="off" aria-label="搜索建筑"></label>
        <div class="zone-tabs" role="group" aria-label="建筑分区"><button type="button" data-zone="全部" class="active">全部</button>${zones.map((item) => `<button type="button" data-zone="${esc(item)}">${esc(item)}</button>`).join('')}</div>
        <div class="list-heading"><span id="list-count"></span><label class="all-toggle"><input id="all-buildings" type="checkbox"><span>含未命名要素</span></label></div>
        <div id="building-list" class="building-list"></div>
        <p class="inventory-note">${data.buildings.length.toLocaleString('zh-CN')} 个模型要素<br><span>含建筑、门墙与楼亭 · 非官方建筑总数</span></p>
      </div>
      <section class="building-detail" id="building-detail" aria-live="polite" hidden></section>
    </aside>
    <section class="mini-map" aria-label="宫城平面图">
      <div class="map-heading"><span>宫城一览</span><span class="map-north">北 ↑</span></div>
      <svg class="map-svg" viewBox="${viewbox}" role="img" aria-label="点击建筑轮廓定位模型">
        ${data.water.map((polygon) => `<polygon class="map-water" points="${points(polygon)}"/>`).join('')}
        <polygon class="map-boundary" points="${points(data.boundary)}"/>
        ${data.buildings.map((building) => `<polygon class="map-building ${building.landmark ? 'map-landmark' : ''}" data-map-id="${esc(building.id)}" points="${points(building.footprint)}"><title>${esc(building.name)}</title></polygon>`).join('')}
      </svg>
      <p class="map-caption">点击轮廓，走近宫殿</p>
    </section>
    <p class="gesture-hint" id="gesture-hint">拖动旋转 <span>·</span> 滚轮缩放 <span>·</span> 右键平移</p>
    <nav class="view-toolbar" aria-label="视图控制">
      <button type="button" id="view-overview" title="恢复南侧全景">${icon('overview')}<span>全景</span></button>
      <button type="button" id="view-top" title="俯视宫城">${icon('top')}<span>俯视</span></button>
      <span class="toolbar-divider"></span>
      <button type="button" id="view-walk" title="地面漫游：WASD 移动，鼠标观察，Esc 退出" aria-pressed="false">${icon('walk')}<span>漫游</span></button>
      <button type="button" id="view-labels" title="显示或隐藏建筑名称" aria-pressed="true">${icon('label')}<span>名称</span></button>
      <span class="toolbar-divider"></span>
      <label class="quality-control"><span>画质</span><select id="view-quality" aria-label="模型画质"><option value="auto">自动</option><option value="high">精细</option><option value="low">流畅</option></select></label>
    </nav>
    <footer class="source-footer"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a><span> / </span><a href="https://www.dpm.org.cn/explore/buildings.html" target="_blank" rel="noopener noreferrer">故宫建筑资料</a></footer>
    <details class="performance"><summary title="查看实时渲染性能" aria-label="查看实时渲染性能">${icon('compass')}</summary><div><span>实时渲染</span><p><strong id="stat-fps">—</strong> FPS</p><p><span id="stat-draws">—</span> 次绘制 · <span id="stat-triangles">—</span> 三角面</p></div></details>
    <div class="walk-banner" id="walk-banner" hidden><span class="live-dot"></span><span>地面漫游</span><span class="walk-instructions">WASD 移动 · 鼠标观察 · Esc 退出</span><button type="button" id="walk-exit">退出 ${icon('close')}</button></div>
    <div class="loading-screen" id="loading-screen" role="status" aria-live="polite">
      <div class="loading-content"><span class="loading-seal" aria-hidden="true">宫</span><p class="eyebrow">THE FORBIDDEN CITY</p><h2>正在铺开紫禁城</h2><p id="loading-text">准备建筑与院落</p><div class="loading-track"><div id="loading-fill"></div></div><span id="loading-percent">0%</span></div>
    </div>
  `;

  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const nav = get('building-nav');
  const navToggle = get<HTMLButtonElement>('nav-toggle');
  const list = get('building-list');
  const detail = get('building-detail');
  const setNav = (open: boolean) => {
    navOpen = open;
    app.classList.toggle('nav-open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    nav.setAttribute('aria-hidden', String(!open));
    nav.inert = !open;
  };
  const choose = (id: string) => {
    select(id);
    actions.select(id);
  };

  function renderList() {
    const matches = data.buildings.filter((building) => (query || showAll || named(building)) && (zone === '全部' || building.zone === zone) && (!query || `${building.name} ${building.zone} ${building.description ?? ''}`.toLowerCase().includes(query)));
    matches.sort((a, b) => Number(Boolean(b.landmark)) - Number(Boolean(a.landmark)) || a.name.localeCompare(b.name, 'zh-CN'));
    get('list-count').textContent = `${matches.length} 项`;
    list.innerHTML = matches.length ? matches.map((building) => `<button class="building-row ${selected === building.id ? 'selected' : ''}" type="button" data-pick="${esc(building.id)}"><span><strong>${esc(building.name)}</strong><small>${esc(building.zone)}</small></span>${building.landmark ? '<span class="landmark-mark" title="代表建筑">◇</span>' : icon('arrow')}</button>`).join('') : '<p class="empty-result">未找到对应建筑<br><span>可换一个名称或分区查找</span></p>';
  }

  function select(id: string | null) {
    selected = id;
    const building = id ? records.get(id) : undefined;
    app.classList.toggle('has-selection', Boolean(building));
    app.querySelectorAll<HTMLElement>('[data-pick]').forEach((button) => button.classList.toggle('selected', button.dataset.pick === id));
    app.querySelectorAll<SVGElement>('[data-map-id]').forEach((polygon) => polygon.classList.toggle('selected', polygon.dataset.mapId === id));
    detail.hidden = !building;
    if (!building) return;
    setNav(true);
    const roofs = { hipped: '庑殿顶', gabled: '双坡屋顶', 'half-hipped': '歇山顶', pyramidal: '攒尖顶', round: '圆形攒尖顶', flat: '平顶', luding: '盝顶' };
    const confidence = { documented: '有文献参照', mapped: '地图轮廓参照', estimated: '比例估算' };
    const sourceUrls = [...new Set((building.source.match(/https?:\/\/[^\s;,，；]+/g) ?? []).map((url) => url.replace(/[。)）]+$/, '')))];
    const sourceLinks = sourceUrls.length ? sourceUrls.map((url, index) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${url.includes('openstreetmap') ? '地图记录' : url.includes('dpm.org.cn') ? '故宫官方资料' : `资料来源 ${index + 1}`} ↗</a>`).join('') : `<span>${esc(building.source || '依照公开建筑布局与同类形制估算')}</span>`;
    detail.innerHTML = `<button type="button" class="detail-back" id="detail-back">← 建筑列表</button><p class="detail-zone">${esc(building.zone)}</p><h3>${esc(building.name)}</h3><div class="detail-facts"><span>${esc(roofs[building.roofKind])}${building.doubleRoof ? ' · 重檐' : ''}</span><span>模型高 ${building.height.toFixed(1)} m</span></div><p class="detail-description">${esc(building.description || '根据地图轮廓与传统宫殿建筑构件生成的外观模型。可旋转、放大，查看屋顶、柱廊与院落关系。')}</p><div class="detail-confidence"><span class="confidence-dot ${building.confidence}"></span>${confidence[building.confidence]}<span class="dimension-note">部分尺寸作展示性近似</span></div><div class="detail-sources">${sourceLinks}</div>`;
    get('detail-back').addEventListener('click', () => select(null));
  }

  app.addEventListener('click', (event) => {
    const target = event.target as Element;
    const pick = target.closest<HTMLElement>('[data-pick]');
    if (pick) choose(pick.dataset.pick!);
    const mapPick = target.closest<SVGElement>('[data-map-id]');
    if (mapPick) choose(mapPick.dataset.mapId!);
    const zonePick = target.closest<HTMLElement>('[data-zone]');
    if (zonePick) {
      zone = zonePick.dataset.zone!;
      app.querySelectorAll<HTMLElement>('[data-zone]').forEach((button) => button.classList.toggle('active', button.dataset.zone === zone));
      renderList();
    }
  });
  get<HTMLInputElement>('building-search').addEventListener('input', (event) => {
    query = (event.target as HTMLInputElement).value.trim().toLowerCase();
    renderList();
  });
  get<HTMLInputElement>('all-buildings').addEventListener('change', (event) => {
    showAll = (event.target as HTMLInputElement).checked;
    renderList();
  });
  navToggle.addEventListener('click', () => setNav(!navOpen));
  get('nav-close').addEventListener('click', () => setNav(false));
  get('view-overview').addEventListener('click', () => actions.overview());
  get('view-top').addEventListener('click', () => actions.top());
  get('view-walk').addEventListener('click', () => actions.walk());
  get('walk-exit').addEventListener('click', () => actions.walk());
  get('view-labels').addEventListener('click', () => {
    setLabels(!labelsVisible);
    actions.labels(labelsVisible);
  });
  get<HTMLSelectElement>('view-quality').addEventListener('change', (event) => actions.quality((event.target as HTMLSelectElement).value as Quality));
  const mobile = window.matchMedia('(max-width: 899px)');
  const updateGestureHint = () => {
    get('gesture-hint').textContent = walking
      ? 'WASD 移动 · Shift 加速 · Esc 返回全景'
      : mobile.matches ? '单指旋转 · 双指缩放与平移' : '拖动旋转 · 滚轮缩放 · 右键平移';
  };
  mobile.addEventListener('change', (event) => {
    if (!walking) setNav(!event.matches);
    updateGestureHint();
  });
  setNav(navOpen);
  renderList();
  updateGestureHint();

  function setLabels(visible: boolean) {
    labelsVisible = visible;
    get('view-labels').setAttribute('aria-pressed', String(visible));
  }

  return {
    select,
    setLabels,
    stats(fps, draws, triangles) {
      get('stat-fps').textContent = Math.round(fps).toString();
      get('stat-draws').textContent = draws.toLocaleString('zh-CN');
      get('stat-triangles').textContent = triangles.toLocaleString('zh-CN');
    },
    walking(active) {
      walking = active;
      app.classList.toggle('is-walking', active);
      get('view-walk').setAttribute('aria-pressed', String(active));
      get('walk-banner').hidden = !active;
      updateGestureHint();
      if (active) setNav(false);
    },
    loading(progress, status) {
      if (completionTimer !== undefined) window.clearTimeout(completionTimer);
      const fraction = Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
      get('loading-fill').style.width = `${fraction * 100}%`;
      get('loading-percent').textContent = `${Math.round(fraction * 100)}%`;
      get('loading-text').textContent = status;
      const screen = get('loading-screen');
      if (fraction >= 1) {
        screen.classList.add('complete');
        completionTimer = window.setTimeout(() => { screen.hidden = true; }, 550);
      } else if (progress < 0) {
        screen.hidden = false;
        screen.classList.remove('complete');
        screen.classList.add('load-error');
        screen.querySelector('h2')!.textContent = '模型暂未载入';
        get('loading-percent').textContent = '请刷新页面后重试';
      }
    },
  };
}
