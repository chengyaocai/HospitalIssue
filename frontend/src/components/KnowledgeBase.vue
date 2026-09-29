<script setup>
// 运维知识库（v1.18.27）：派生视图、只读。
// 所有写了处理说明（resolution 非空）的问题由后端自动收录，本组件不做任何写操作；
// 提供关键字搜索（300ms 防抖）+ 类型过滤 + 分页。
// v1.18.31：卡片「原地展开」改为「点击弹框展示」——长处理说明会把列表撑开、扫读体验差；
// 卡片只保留 2 行预览，全文进只读详情弹框（项目约定：@click.self 不关闭，按钮关闭）。
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const keyword = ref('');
const type = ref('');
const TYPES = ['故障', '需求', '咨询', '其他'];
const loading = ref(false);
const error = ref('');

// 当前查看的条目（详情弹框）
const detail = ref(null);

// 关键字防抖（300ms）：输入停顿后再检索；筛选变化一律回到第 1 页
let debounceTimer = null;
function onKeywordInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { page.value = 1; load(); }, 300);
}
function onTypeChange() { page.value = 1; load(); }

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await api.kbList({
      keyword: keyword.value || undefined,
      type: type.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    rows.value = r.rows || [];
    total.value = r.total || 0;
  } catch (e) {
    error.value = e.message || '加载失败，请稍后重试';
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function changePage(p) {
  if (p < 1) return;
  const maxPage = Math.max(1, Math.ceil(total.value / pageSize.value));
  if (p > maxPage) return;
  page.value = p;
  load();
}
const totalPages = () => Math.max(1, Math.ceil(total.value / pageSize.value));

// 时间格式化（yyyy-MM-dd HH:mm），容错空值 / 非法日期
function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

onMounted(load);
</script>

<template>
  <section class="kb-page">
    <header class="page-head">
      <div>
        <h1>运维知识库</h1>
        <p class="sub">
          共 <b>{{ total }}</b> 条 · 填写了处理说明的问题会自动收录至此，无需手工维护
        </p>
      </div>
    </header>

    <div class="kb-tools">
      <input
        v-model="keyword"
        class="kb-search"
        type="search"
        placeholder="搜索标题 / 问题描述 / 处理说明 / 软件系统"
        @input="onKeywordInput"
      />
      <select v-model="type" class="kb-type" @change="onTypeChange">
        <option value="">全部类型</option>
        <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
    </div>

    <p v-if="error" class="kb-error">{{ error }}</p>

    <div v-if="rows.length" class="kb-list">
      <article
        v-for="r in rows"
        :key="r.id"
        class="kb-card"
        role="button"
        tabindex="0"
        :aria-label="'查看「' + r.title + '」详情'"
        @click="detail = r"
        @keydown.enter.prevent="detail = r"
      >
        <div class="kb-card-head">
          <h3 class="kb-title">{{ r.title }}</h3>
          <span class="kb-open-hint">详情</span>
        </div>
        <div class="kb-chips">
          <span v-if="r.softwareSystem" class="chip">{{ r.softwareSystem }}</span>
          <span v-if="r.type" class="chip">{{ r.type }}</span>
          <span v-if="r.status" class="chip" :class="'kb-st-' + r.status">{{ r.status }}</span>
        </div>
        <p class="kb-meta">
          <span v-if="r.handler">处理人：{{ r.handler }}</span>
          <span>更新：{{ fmtTime(r.updated_at) || '—' }}</span>
        </p>
        <p class="kb-resolution">{{ r.resolution }}</p>
      </article>
    </div>

    <div v-else-if="!loading && !error" class="kb-empty">
      <template v-if="keyword">
        没有匹配「{{ keyword }}」的条目。
      </template>
      <template v-else>
        暂无知识库条目。在「问题登记」中为问题填写处理说明并保存后，会自动进入这里。
      </template>
    </div>

    <div v-if="rows.length" class="kb-pager">
      <span class="kb-pager-info">共 {{ total }} 条 · 第 {{ page }}/{{ totalPages() }} 页</span>
      <div class="kb-pager-btns">
        <button class="small" :disabled="page <= 1" @click.stop="changePage(page - 1)">上一页</button>
        <button class="small" :disabled="page >= totalPages()" @click.stop="changePage(page + 1)">下一页</button>
      </div>
    </div>

    <!-- 知识条目只读详情弹框（v1.18.31）：点击卡片打开；按项目约定 @click.self 不关闭 -->
    <div v-if="detail" class="modal-mask" @click.self>
      <div class="modal kb-modal" role="dialog" aria-modal="true" :aria-label="detail.title">
        <div class="kb-modal-head">
          <h3 class="kb-modal-title">{{ detail.title }}</h3>
          <button class="icon-btn" aria-label="关闭详情" @click="detail = null">✕</button>
        </div>
        <div class="kb-chips">
          <span v-if="detail.softwareSystem" class="chip">{{ detail.softwareSystem }}</span>
          <span v-if="detail.type" class="chip">{{ detail.type }}</span>
          <span v-if="detail.status" class="chip" :class="'kb-st-' + detail.status">{{ detail.status }}</span>
        </div>
        <p class="kb-modal-meta">
          <span v-if="detail.department">科室：{{ detail.department }}</span>
          <span v-if="detail.reporter">提出人：{{ detail.reporter }}</span>
          <span v-if="detail.registrar">登记人：{{ detail.registrar }}</span>
          <span v-if="detail.handler">处理人：{{ detail.handler }}</span>
        </p>
        <p class="kb-modal-meta">
          <span>登记：{{ fmtTime(detail.created_at) || '—' }}</span>
          <span>更新：{{ fmtTime(detail.updated_at) || '—' }}</span>
          <span v-if="detail.resolved_at">解决：{{ fmtTime(detail.resolved_at) }}</span>
        </p>
        <div class="kb-sec">
          <h4>问题描述</h4>
          <p class="kb-text">{{ detail.description || '（无）' }}</p>
        </div>
        <div class="kb-sec">
          <h4>处理说明</h4>
          <p class="kb-text">{{ detail.resolution || '（无）' }}</p>
        </div>
        <div class="kb-modal-foot">
          <button class="small primary" @click="detail = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 状态语义色（与 Chat.vue ref-chip 自包含实现一致：待处理=黄 / 处理中=蓝 / 已解决=绿 / 已关闭=灰） */
.kb-st-待处理 { background: #fef3c7; color: #b45309; }
.kb-st-处理中 { background: #e0edff; color: #1d4ed8; }
.kb-st-已解决 { background: #dcfce7; color: #15803d; }
.kb-st-已关闭 { background: #eef2f7; color: #64748b; }

.kb-page { display: flex; flex-direction: column; gap: 14px; }
.kb-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.kb-search {
  flex: 1 1 260px; max-width: 420px;
  padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: 10px;
  background: var(--panel); color: var(--text); font-size: 13.5px;
}
.kb-search:focus { outline: 2px solid var(--primary); outline-offset: -1px; border-color: var(--primary); }
.kb-type {
  padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: 10px;
  background: var(--panel); color: var(--text); font-size: 13.5px;
}
.kb-error { margin: 0; color: #b91c1c; font-size: 13px; }

.kb-list { display: flex; flex-direction: column; gap: 12px; }
.kb-card {
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--shadow); padding: 14px 16px; cursor: pointer;
  transition: border-color .12s, box-shadow .12s;
}
.kb-card:hover { border-color: var(--primary); }
.kb-card-head { display: flex; align-items: baseline; gap: 10px; }
.kb-title { margin: 0; font-size: 14.5px; font-weight: 650; color: var(--text); word-break: break-word; flex: 1; }
.kb-open-hint { flex: none; font-size: 12px; color: var(--muted); }
.kb-card:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.kb-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.kb-chips .chip { font-weight: 600; }
.kb-meta { margin: 8px 0 0; display: flex; gap: 14px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }
.kb-resolution {
  margin: 8px 0 0; font-size: 13px; color: var(--muted); white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

/* —— v1.18.31：详情弹框（复用全局 .modal-mask/.modal，自带 90vh 滚动）—— */
.kb-modal-head { display: flex; align-items: flex-start; gap: 10px; }
.kb-modal-title { flex: 1; word-break: break-word; }
.kb-modal .kb-chips { margin: 0 0 10px; }
.kb-modal-meta {
  margin: 0 0 6px; display: flex; gap: 14px; flex-wrap: wrap;
  font-size: 12.5px; color: var(--muted);
}
.kb-sec { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
.kb-sec h4 { margin: 0 0 6px; font-size: 12.5px; color: var(--muted); font-weight: 600; }
.kb-text { margin: 0; font-size: 13.5px; color: var(--text); white-space: pre-wrap; word-break: break-word; line-height: 1.65; }
.kb-modal-foot { margin-top: 18px; display: flex; justify-content: flex-end; }

.kb-empty {
  padding: 36px 20px; text-align: center; color: var(--muted); font-size: 13.5px;
  background: var(--panel); border: 1px dashed var(--border-strong); border-radius: 12px;
}

.kb-pager { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.kb-pager-info { font-size: 12.5px; color: var(--muted); }
.kb-pager-btns { display: flex; gap: 8px; }
.kb-pager-btns button:disabled { opacity: .45; cursor: not-allowed; }
</style>
