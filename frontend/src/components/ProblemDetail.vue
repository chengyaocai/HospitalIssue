<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, SATISFACTIONS } from '../api.js';

const props = defineProps({ problem: Object, canDelete: Boolean, canEdit: Boolean, canRate: Boolean });
const emit = defineEmits(['close', 'edit', 'delete', 'refresh']);

const p = computed(() => props.problem || {});
const atts = computed(() => (Array.isArray(p.value.attachments) ? p.value.attachments : []));

function fmt(t) { return t ? new Date(t).toLocaleString('zh-CN') : '—'; }
function sizeText(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
async function download(a) {
  try { await api.downloadAttachment(p.value.id, a.id, a.originalName); }
  catch (e) { alert(e.message || '下载失败'); }
}

// ===== 附件预览（fetch blob → objectURL，弹框在线展示；后端零改动） =====
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
const PDF_EXTS = ['pdf'];
const TEXT_EXTS = ['txt', 'md', 'log', 'json', 'csv', 'xml', 'ini', 'conf'];

// previewFile 非空即弹框打开；previewStatus: loading | ready | error | unsupported
const previewFile = ref(null);
const previewKind = ref('other');   // image | pdf | text | other
const previewUrl = ref('');         // 图片/PDF 的 object URL
const previewText = ref('');        // 文本类文件的内容
const previewStatus = ref('loading');
const previewError = ref('');

function extOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
function kindOf(name) {
  const e = extOf(name);
  if (IMAGE_EXTS.includes(e)) return 'image';
  if (PDF_EXTS.includes(e)) return 'pdf';
  if (TEXT_EXTS.includes(e)) return 'text';
  return 'other';
}
function revokePreviewUrl() {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = '';
  }
}

function closePreview() {
  revokePreviewUrl();
  previewFile.value = null;
  previewStatus.value = 'loading';
  previewText.value = '';
  previewError.value = '';
  resetPreviewTransform(); // 关闭时归零旋转 / 镜像
}

// 请求序号：防止快速连点两个附件时，旧请求晚归覆盖新状态 / 泄漏旧 objectURL
let loadSeq = 0;

async function loadPreview(pid, a) {
  const seq = ++loadSeq;
  previewStatus.value = 'loading';
  previewError.value = '';
  try {
    const blob = await api.fetchAttachmentBlob(pid, a.id);
    if (seq !== loadSeq) return; // 已有更新的预览请求，丢弃本次响应
    if (previewKind.value === 'text') {
      // 文本：先按严格 UTF-8 解码；出现 U+FFFD 替换符说明多半是 GBK 等本地编码，再用 GBK 重解
      const buf = await blob.arrayBuffer();
      if (seq !== loadSeq) return;
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if (text.includes('\uFFFD')) {
        try { text = new TextDecoder('gbk').decode(buf); } catch { /* 解码器不可用则保留 UTF-8 结果 */ }
      }
      previewText.value = text;
    } else {
      previewUrl.value = URL.createObjectURL(blob);
    }
    previewStatus.value = 'ready';
  } catch (e) {
    if (seq !== loadSeq) return; // 旧请求的失败也不覆盖新状态
    previewError.value = e.message || '加载失败';
    previewStatus.value = 'error';
  }
}

async function openPreview(a) {
  revokePreviewUrl();
  previewText.value = '';
  previewError.value = '';
  resetPreviewTransform(); // 换文件时归零旋转 / 镜像
  previewKind.value = kindOf(a.originalName);
  previewFile.value = a;
  if (previewKind.value === 'other') {
    // docx/xlsx 等无法在线渲染，直接给出下载提示
    previewStatus.value = 'unsupported';
    return;
  }
  await loadPreview(p.value.id, a);
}

function retryPreview() {
  if (!previewFile.value) return;
  resetPreviewTransform(); // 防御式重置：当前 rotation 恒为 0，未来 error 态放开旋转按钮也不会踩坑
  revokePreviewUrl();
  loadPreview(p.value.id, previewFile.value);
}

function downloadFromPreview() {
  if (previewFile.value) download(previewFile.value);
}

// ===== 预览图片旋转 / 镜像（仅图片分支的工具按钮） =====
// rotation 保存累计角度、不取模：跨 360° 时 transition 才不会回跳
const previewRotation = ref(0);
const previewMirror = ref(false);
// 奇数个 90°（90/270…）时视觉宽高与布局盒宽高互换，需要收紧尺寸约束
const isOddTurn = computed(() => Math.round(previewRotation.value / 90) % 2 !== 0);

function rotatePreview(dir) {
  previewRotation.value += dir * 90;
}
function toggleMirror() {
  previewMirror.value = !previewMirror.value;
}

// ===== 预览图片缩放（仅图片分支；与旋转/镜像独立，复位缩放不影响旋转/镜像） =====
// zoom 语义：实参即目标倍率，函数内部只做钳制、不再二次缩放（避免 180° 那类「实参 × 内部步长」叠加 bug）
const ZOOM_MIN = 0.2;          // 缩放下限 20%
const ZOOM_MAX = 5;            // 缩放上限 500%
const ZOOM_STEP_BTN = 1.25;    // 按钮 ± 每档倍率（×1.25 / ÷1.25）
const ZOOM_STEP_WHEEL = 1.15;  // 滚轮每档倍率（×1.15 / ÷1.15，手感更细）
const previewZoom = ref(1);

// 百分比展示：Math.round 消除浮点尾巴（如 1.30000000000000004 → 130%）
const zoomPercent = computed(() => Math.round(previewZoom.value * 100) + '%');
// 边界态：到 0.2 / 5 后按钮置灰，滚轮同样不再变化
const atZoomMin = computed(() => previewZoom.value <= ZOOM_MIN);
const atZoomMax = computed(() => previewZoom.value >= ZOOM_MAX);

function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}
function applyZoom(target) {
  previewZoom.value = clampZoom(target);
}
function zoomInPreview() {
  applyZoom(previewZoom.value * ZOOM_STEP_BTN);
}
function zoomOutPreview() {
  applyZoom(previewZoom.value / ZOOM_STEP_BTN);
}
function resetPreviewZoom() {
  previewZoom.value = 1; // 仅复位缩放到 100% 适应窗口，旋转/镜像保持不变
}
// 滚轮缩放：绑定在 img 上（只在图片分支渲染），向上滚放大 / 向下滚缩小；.prevent 阻止页面滚动
function onPreviewWheel(e) {
  if (previewKind.value !== 'image' || previewStatus.value !== 'ready') return;
  const factor = e.deltaY < 0 ? ZOOM_STEP_WHEEL : 1 / ZOOM_STEP_WHEEL;
  applyZoom(previewZoom.value * factor);
}

function resetPreviewTransform() {
  previewRotation.value = 0;
  previewMirror.value = false;
  previewZoom.value = 1; // 换文件 / 关闭 / 重试时缩放一并归位
}

// Esc 关闭预览弹框（弹框打开时优先于抽屉自身逻辑）
function onPreviewKeydown(e) {
  if (e.key === 'Escape' && previewFile.value) closePreview();
}
onMounted(() => window.addEventListener('keydown', onPreviewKeydown));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onPreviewKeydown);
  revokePreviewUrl();
});

// 回访打分（仅登记人本人或管理员可见可编辑）
const pick = ref('');
const fb = ref('');
const saving = ref(false);
watch(() => props.problem, (v) => {
  pick.value = (v && v.satisfaction) || '';
  fb.value = (v && v.feedback) || '';
}, { immediate: true });

async function saveRate() {
  if (!pick.value) { alert('请选择满意度'); return; }
  saving.value = true;
  try {
    const updated = await api.rateSatisfaction(p.value.id, { satisfaction: pick.value, feedback: fb.value.trim() });
    emit('refresh', updated);
  } catch (e) {
    alert(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}
async function clearRate() {
  saving.value = true;
  try {
    const updated = await api.rateSatisfaction(p.value.id, { satisfaction: '', feedback: '' });
    pick.value = ''; fb.value = '';
    emit('refresh', updated);
  } catch (e) {
    alert(e.message || '清空失败');
  } finally {
    saving.value = false;
  }
}
function satClass(s) {
  return { '满意': 'sat-good', '一般': 'sat-mid', '不满意': 'sat-bad' }[s] || '';
}

// 审核信息（只读展示）
const auditDone = computed(() => p.value.audit_status === '已通过' || p.value.audit_status === '不通过');
function auditBadgeClass(v) {
  if (v === '已通过') return 'audit-pass';
  if (v === '不通过') return 'audit-reject';
  return 'audit-pending';
}
</script>

<template>
  <div class="drawer-mask">
    <aside class="drawer">
      <header class="drawer-head">
        <div class="drawer-head-txt">
          <span class="drawer-eyebrow">问题 #{{ p.id }}</span>
          <h3>{{ p.title }}</h3>
        </div>
        <button class="icon-btn" title="关闭" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div class="drawer-body">
        <div class="tag-row">
          <span class="st" :class="'st-' + p.status">{{ p.status }}</span>
          <span class="sev" :class="'sev-' + p.severity">严重程度 · {{ p.severity }}</span>
          <span class="chip">{{ p.type }}</span>
          <span v-if="p.satisfaction" class="sat" :class="satClass(p.satisfaction)">满意度 · {{ p.satisfaction }}</span>
          <span class="audit-badge" :class="auditBadgeClass(p.audit_status)">审核 · {{ p.audit_status || '待审核' }}</span>
        </div>

        <dl class="kv">
          <div><dt>所属科室</dt><dd>{{ p.department || '—' }}</dd></div>
          <div><dt>提出人</dt><dd>{{ p.reporter || '—' }}</dd></div>
          <div><dt>登记人</dt><dd>{{ p.registrar || '—' }}</dd></div>
          <div><dt>联系方式</dt><dd>{{ p.contact || '—' }}</dd></div>
          <div><dt>处理人</dt><dd>{{ p.handler || '—' }}</dd></div>
          <div><dt>软件系统</dt><dd>{{ p.softwareSystem || '—' }}</dd></div>
          <div><dt>登记时间</dt><dd>{{ fmt(p.created_at) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ fmt(p.updated_at) }}</dd></div>
          <div><dt>解决时间</dt><dd>{{ fmt(p.resolved_at) }}</dd></div>
          <div v-if="p.rated_at"><dt>回访时间</dt><dd>{{ fmt(p.rated_at) }}</dd></div>
        </dl>

        <section class="drawer-sec">
          <h4>问题描述</h4>
          <p class="pre">{{ p.description || '—' }}</p>
        </section>

        <section class="drawer-sec">
          <h4>处理说明</h4>
          <p class="pre">{{ p.resolution || '暂无处理说明' }}</p>
        </section>

        <!-- 审核信息（只读展示；审核操作在列表页「审核」按钮弹框中完成） -->
        <section class="drawer-sec">
          <h4>审核信息</h4>
          <div v-if="auditDone" class="audit-current" :class="auditBadgeClass(p.audit_status)">
            <span class="audit-badge">{{ p.audit_status }}</span>
            <p v-if="p.audit_status === '不通过' && p.audit_reason" class="audit-reason">不通过原因：{{ p.audit_reason }}</p>
          </div>
          <div v-else class="audit-current muted">待审核（尚未审核）</div>
          <dl v-if="auditDone" class="kv audit-kv">
            <div><dt>审核人</dt><dd>{{ p.audit_by || '—' }}</dd></div>
            <div><dt>审核时间</dt><dd>{{ fmt(p.audit_at) }}</dd></div>
          </dl>
        </section>

        <!-- 回访与满意度 -->
        <section class="drawer-sec">
          <h4>问题回访 / 满意度</h4>
          <div v-if="p.satisfaction" class="sat-current" :class="satClass(p.satisfaction)">
            <span class="sat-badge">{{ p.satisfaction }}</span>
            <p v-if="p.feedback" class="sat-fb">“{{ p.feedback }}”</p>
            <span v-else class="sat-fb muted">（无备注）</span>
          </div>
          <div v-else class="sat-current muted">尚未回访</div>

          <div v-if="canRate" class="rate-box">
            <div class="rate-row">
              <button
                v-for="s in SATISFACTIONS" :key="s"
                class="rate-btn" :class="[satClass(s), { active: pick === s }]"
                @click="pick = s"
              >{{ s }}</button>
            </div>
            <textarea v-model="fb" rows="2" placeholder="回访备注（可选）"></textarea>
            <div class="rate-acts">
              <button class="small primary" :disabled="saving" @click="saveRate">保存回访</button>
              <button v-if="p.satisfaction" class="small" :disabled="saving" @click="clearRate">清空回访</button>
            </div>
          </div>
          <p v-else class="rate-tip">仅登记人本人或管理员可填写回访</p>
        </section>

        <section class="drawer-sec">
          <h4>附件（{{ atts.length }}）</h4>
          <ul v-if="atts.length" class="attach-list">
            <li v-for="a in atts" :key="a.id">
              <a href="javascript:void(0)" class="att-name" :title="'点击预览 ' + a.originalName" @click="openPreview(a)">{{ a.originalName }}</a>
              <button class="att-dl" :title="'下载 ' + a.originalName" @click="download(a)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3v12M6.5 10.5 12 16l5.5-5.5M4 20h16" />
                </svg>
              </button>
              <span class="meta">{{ sizeText(a.size) }} · {{ a.uploadedBy }}</span>
            </li>
          </ul>
          <p v-else class="attach-empty">暂无附件</p>
        </section>
      </div>

      <footer class="drawer-foot">
        <button v-if="canEdit" class="primary" @click="emit('edit', p)">编辑</button>
        <button v-if="canDelete" class="danger" @click="emit('delete', p)">删除</button>
        <button @click="emit('close')">关闭</button>
      </footer>
    </aside>

    <!-- 附件预览弹框（全屏遮罩，盖在抽屉之上；Esc / 关闭按钮可退出，点击遮罩不再关闭） -->
    <div v-if="previewFile" class="preview-mask">
      <div class="preview-box" :class="{ 'is-pdf': previewKind === 'pdf' && previewStatus === 'ready' }">
        <header class="preview-head">
          <div class="preview-title">
            <span class="preview-name" :title="previewFile.originalName">{{ previewFile.originalName }}</span>
            <span class="preview-size">{{ sizeText(previewFile.size) }}</span>
          </div>
          <div class="preview-tools">
            <template v-if="previewKind === 'image' && previewStatus === 'ready'">
              <button class="icon-btn tool-btn" title="左旋 90°" @click="rotatePreview(-1)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2.5 4v6h6" />
                  <path d="M4.2 15a8.5 8.5 0 1 0 2-8.8L2.5 10" />
                </svg>
              </button>
              <button class="icon-btn tool-btn" title="右旋 90°" @click="rotatePreview(1)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21.5 4v6h-6" />
                  <path d="M19.8 15a8.5 8.5 0 1 1-2-8.8L21.5 10" />
                </svg>
              </button>
              <button class="icon-btn tool-btn" :class="{ active: previewMirror }" title="水平镜像" @click="toggleMirror">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 7 3 12l6 5V7zM15 7l6 5-6 5V7z" />
                  <path d="M12 3v18" stroke-dasharray="2.5 2.5" />
                </svg>
              </button>
              <button class="icon-btn tool-btn" title="放大" :disabled="atZoomMax" @click="zoomInPreview">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="10.5" cy="10.5" r="6.5" />
                  <path d="M15.5 15.5 21 21" />
                  <path d="M10.5 7.5v6M7.5 10.5h6" />
                </svg>
              </button>
              <button class="icon-btn tool-btn" title="缩小" :disabled="atZoomMin" @click="zoomOutPreview">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="10.5" cy="10.5" r="6.5" />
                  <path d="M15.5 15.5 21 21" />
                  <path d="M7.5 10.5h6" />
                </svg>
              </button>
              <button class="icon-btn tool-btn" title="复位缩放（100%）" @click="resetPreviewZoom">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9" />
                  <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9" />
                  <path d="M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15" />
                  <path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
                  <circle cx="12" cy="12" r="2" />
                </svg>
              </button>
              <span class="zoom-label" title="当前缩放比例">{{ zoomPercent }}</span>
            </template>
            <button class="icon-btn" title="关闭预览" @click="closePreview">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </header>

        <div class="preview-body" :class="'kind-' + previewKind">
          <p v-if="previewStatus === 'loading'" class="preview-msg">加载中…</p>

          <div v-else-if="previewStatus === 'error'" class="preview-msg error">
            <p>预览加载失败：{{ previewError }}</p>
            <div class="preview-acts">
              <button class="small primary" @click="retryPreview">重试</button>
              <button class="small" @click="downloadFromPreview">下载文件</button>
            </div>
          </div>

          <div v-else-if="previewStatus === 'unsupported'" class="preview-msg">
            <p>该文件类型暂不支持预览，请下载查看。</p>
            <div class="preview-acts">
              <button class="small primary" @click="downloadFromPreview">下载文件</button>
            </div>
          </div>

          <img
            v-else-if="previewKind === 'image'"
            :class="{ rotated: isOddTurn }"
            :style="{ transform: `scale(${previewZoom}) scaleX(${previewMirror ? -1 : 1}) rotate(${previewRotation}deg)` }"
            @wheel.prevent="onPreviewWheel"
            :src="previewUrl" :alt="previewFile.originalName"
          />
          <iframe
            v-else-if="previewKind === 'pdf'"
            :src="previewUrl" :title="previewFile.originalName"
          ></iframe>
          <pre v-else-if="previewKind === 'text'" class="preview-text">{{ previewText }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sat-current { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--border); margin-bottom: 12px; }
.sat-current.muted { color: var(--muted); font-size: 13px; }
.sat-badge { font-weight: 650; padding: 2px 10px; border-radius: 999px; font-size: 12.5px; }
.sat-fb { margin: 0; font-size: 13px; color: var(--text); font-style: italic; }
.sat-fb.muted { color: var(--muted); font-style: normal; }
.sat-good .sat-badge { background: #dcfce7; color: #15803d; }
.sat-mid .sat-badge { background: #fef3c7; color: #b45309; }
.sat-bad .sat-badge { background: #fee2e2; color: #b91c1c; }

.rate-box { border: 1px dashed var(--border-strong); border-radius: 12px; padding: 12px; background: #fbfdff; }
.rate-row { display: flex; gap: 8px; margin-bottom: 10px; }
.rate-btn {
  flex: 1; padding: 8px 0; border-radius: 9px; font-size: 13px;
  border: 1px solid var(--border-strong); background: #fff; color: var(--text); cursor: pointer;
}
.rate-btn.sat-good.active, .rate-btn.sat-good:hover { border-color: #15803d; background: #dcfce7; color: #15803d; }
.rate-btn.sat-mid.active, .rate-btn.sat-mid:hover { border-color: #b45309; background: #fef3c7; color: #b45309; }
.rate-btn.sat-bad.active, .rate-btn.sat-bad:hover { border-color: #b91c1c; background: #fee2e2; color: #b91c1c; }
.rate-box textarea { width: 100%; border: 1px solid var(--border-strong); border-radius: 9px; padding: 9px 11px; font-size: 13px; font-family: inherit; resize: vertical; background: #fff; }
.rate-acts { display: flex; gap: 8px; margin-top: 10px; }
.rate-tip { font-size: 12.5px; color: var(--muted); margin: 4px 0 0; }

/* 审核信息 */
.audit-current { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--border); margin-bottom: 12px; }
.audit-current.muted { color: var(--muted); font-size: 13px; }
.audit-reason { margin: 0; font-size: 13px; color: var(--text); }
.audit-kv { margin-top: 4px; }

/* 附件列表：文件名=预览，右侧独立下载小按钮 */
.attach-list li { gap: 8px; }
.attach-list .att-name { cursor: pointer; }
.att-dl {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; flex: none;
  border: 1px solid var(--border-strong); border-radius: 7px;
  background: var(--panel-2); color: var(--muted); cursor: pointer;
}
.att-dl:hover { color: var(--primary); border-color: var(--primary); background: var(--panel); }
.att-dl svg { width: 14px; height: 14px; }

/* 附件预览弹框（全屏遮罩，层级高于抽屉与通用弹框） */
.preview-mask {
  position: fixed; inset: 0; z-index: 120;
  background: rgba(15, 23, 42, .62); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.preview-box {
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  width: min(1100px, 94vw); max-height: 92vh;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: var(--shadow-lg);
}
.preview-box.is-pdf { height: 92vh; }
.preview-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--panel-2); flex: none;
}
.preview-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.preview-name {
  font-weight: 600; font-size: 14px; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60vw;
}
.preview-size { font-size: 12px; color: var(--muted); white-space: nowrap; }
.preview-body { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: auto; background: var(--panel); }

/* 图片：中性深色底衬托，深浅主题下均可读 */
.kind-image { background: #1f2937; }
.kind-image img { max-width: 90vw; max-height: 85vh; object-fit: contain; display: block; transition: transform .2s ease; }

/* 缩放后的平移方案（flex 居中 + overflow:auto 的经典裁切解法）：
   transform:scale 不改变布局盒，放大后溢出靠 .preview-body 滚动查看。
   但父级 justify/align 的 center 在溢出时会把内容推向两侧，
   起始方向（左/上）的溢出无法滚动到——所以图片分支覆写为 flex-start，
   由 img 的 margin:auto 负责居中：有富余空间时四向自动居中（无滚动条），
   放大溢出时 auto margin 归零、内容贴起点，四边均可滚动查看。 */
.kind-image { justify-content: flex-start; align-items: flex-start; }
.kind-image img { margin: auto; }
/* 图片分支的加载/失败/不支持提示：随父级改为 flex-start 后用 margin:auto 恢复居中
   （提示内容小、永不溢出，auto margin 恒居中） */
.kind-image .preview-msg { margin: auto; }

/* 旋转 90°/270° 时的尺寸适配：transform 不改变布局盒，旋转后可视宽高 = 盒高宽互换。
   把两个方向的约束都收紧到 min(90vw, 85vh)，无论原图横竖，
   旋转后的可视包围盒都同时满足 90vw / 85vh 两个上限——
   纯 CSS、无需 JS 测量，保证完整可见、不裁切、不出滚动条。
   （不采用"交换 max-width/max-height"方案：它依赖 body 实际宽高，
   极端窗口比例下仍可能溢出；对称收紧更稳。） */
.kind-image img.rotated { max-width: min(90vw, 85vh); max-height: min(90vw, 85vh); }

/* 预览头部工具按钮（旋转 / 镜像 / 缩放），对齐既有 icon-btn 视觉 */
.preview-tools { display: flex; align-items: center; gap: 6px; flex: none; }
.tool-btn { color: var(--muted); }
.tool-btn:hover { color: var(--primary); border-color: var(--primary); background: var(--panel); }
.tool-btn.active { color: var(--primary); border-color: var(--primary); background: var(--panel); }
.tool-btn:disabled { opacity: .4; cursor: not-allowed; }
.tool-btn:disabled:hover { color: var(--muted); border-color: var(--border); background: transparent; }
.tool-btn svg { width: 15px; height: 15px; }
.zoom-label {
  font-size: 12px; color: var(--muted); min-width: 40px; text-align: center;
  font-variant-numeric: tabular-nums; user-select: none; white-space: nowrap;
}

/* PDF：iframe 占满（浏览器内置查看器，白底为自带） */
.kind-pdf { display: block; }
.kind-pdf iframe { width: 100%; height: 100%; border: 0; display: block; }

/* 文本：整块渲染，可滚动 */
.kind-text { display: block; }
.preview-text {
  margin: 0; padding: 14px 18px; width: 100%;
  font-size: 13px; line-height: 1.65; color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace;
  white-space: pre-wrap; word-break: break-all;
}

/* 加载 / 失败 / 不支持 提示 */
.preview-msg { margin: 0; padding: 48px 20px; font-size: 13.5px; color: var(--muted); text-align: center; }
.preview-msg.error p { color: var(--danger); margin: 0 0 4px; }
.preview-acts { display: flex; justify-content: center; gap: 10px; margin-top: 14px; }
</style>
