<!-- apps/kimi-web/src/components/settings/ProviderManager.vue -->
<!-- Provider settings surface: the list can be embedded page-level, while
     create/edit remains a focused dialog with per-model context sizes. -->
<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppModel, AppProvider, AppProviderDetail, AppProviderInput } from '../../api/types';
import { useDialogFocus } from '../../composables/useDialogFocus';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Badge from '../ui/Badge.vue';
import Spinner from '../ui/Spinner.vue';
import Skeleton from '../ui/Skeleton.vue';
import EmptyState from '../ui/EmptyState.vue';
import Field from '../ui/Field.vue';
import Input from '../ui/Input.vue';
import Select from '../ui/Select.vue';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';
import Banner from '../ui/Banner.vue';

const { t } = useI18n();

const dialogRef = ref<HTMLElement | null>(null);

const props = defineProps<{
  providers: AppProvider[];
  /** Model catalog — prefills the edit form's model rows for a provider. */
  models: AppModel[];
  loading?: boolean;
  /** If true, providers could not be fetched (daemon 404 / unsupported) */
  unavailable?: boolean;
  /** Show the provider list as a page-level settings surface. */
  embedded?: boolean;
  /** Full single-provider read (stored api key included) for edit prefill. */
  loadDetail: (id: string) => Promise<AppProviderDetail | null>;
  /** Create (existingId undefined) or replace a provider. True = saved. */
  save: (input: AppProviderInput, existingId?: string) => Promise<boolean>;
}>();

// Move focus into the standalone dialog on open; the parent Settings dialog
// owns focus when this manager is embedded as its second/third-level content.
if (!props.embedded) useDialogFocus(dialogRef);

const emit = defineEmits<{
  refresh: [id: string];
  delete: [id: string];
  /** Open the login dialog for the given platform (OAuth flow) */
  openLogin: [platform: string];
  close: [];
}>();

// -------------------------------------------------------------------------
// Delete confirmation
// -------------------------------------------------------------------------

// Delete — the modal confirm and the async delete live in App.vue
// (confirmDeleteProvider); the manager only emits the intent.
function onDeleteProvider(id: string): void {
  emit('delete', id);
}

// -------------------------------------------------------------------------
// Create / edit form
// -------------------------------------------------------------------------

// The six wire protocols the server accepts as a provider `type`
// (kap-server rest-modelCatalog providerWireTypeSchema).
const PROVIDER_TYPES = [
  'openai',
  'openai_responses',
  'anthropic',
  'kimi',
  'google-genai',
  'vertexai',
];
const DEFAULT_CONTEXT_SIZE = 131_072;

interface ModelRow {
  model: string;
  displayName: string;
  /** `v-model.number` yields '' while the field is cleared. */
  maxContextSize: number | string;
}

const formOpen = ref(false);
/** Set while editing an existing provider (its current id, for PUT). */
const editingId = ref<string | undefined>(undefined);
const editLoading = ref(false);
const formBusy = ref(false);
const formError = ref('');
/** Edit mode: whether the provider already has a stored key (empty input = keep). */
const hasStoredKey = ref(false);
const showApiKey = ref(false);
const form = reactive({
  id: '',
  type: 'openai',
  apiKey: '',
  baseUrl: '',
  defaultModel: '',
  models: [] as ModelRow[],
});

function emptyRow(): ModelRow {
  return { model: '', displayName: '', maxContextSize: DEFAULT_CONTEXT_SIZE };
}

function openAdd(): void {
  editingId.value = undefined;
  hasStoredKey.value = false;
  showApiKey.value = false;
  form.id = '';
  form.type = 'openai';
  form.apiKey = '';
  form.baseUrl = '';
  form.defaultModel = '';
  form.models = [emptyRow()];
  formError.value = '';
  formOpen.value = true;
}

function openDeepSeek(): void {
  editingId.value = undefined;
  hasStoredKey.value = false;
  showApiKey.value = false;
  form.id = 'deepseek';
  form.type = 'openai';
  form.apiKey = '';
  form.baseUrl = 'https://api.deepseek.com';
  form.defaultModel = 'deepseek-v4-flash';
  form.models = [
    {
      model: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      maxContextSize: 1_000_000,
    },
    {
      model: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      maxContextSize: 1_000_000,
    },
  ];
  formError.value = '';
  formOpen.value = true;
}

/** The raw model name for a catalog entry (alias ids are `<provider>/<model>`). */
function rawModelName(aliasId: string, providerId: string): string {
  const prefix = `${providerId}/`;
  return aliasId.startsWith(prefix) ? aliasId.slice(prefix.length) : aliasId;
}

async function openEdit(provider: AppProvider): Promise<void> {
  editLoading.value = true;
  try {
    const detail = await props.loadDetail(provider.id);
    if (detail === null) return;
    editingId.value = provider.id;
    hasStoredKey.value = detail.hasApiKey;
    showApiKey.value = false;
    form.id = detail.id;
    form.type = detail.type;
    // Edit mode intentionally shows the stored key so it can be inspected or
    // edited directly. An empty key still keeps it unchanged on save.
    form.apiKey = detail.apiKey ?? '';
    form.baseUrl = detail.baseUrl ?? '';
    form.defaultModel =
      detail.defaultModel === undefined ? '' : rawModelName(detail.defaultModel, provider.id);
    const rows = props.models
      .filter((model) => model.provider === provider.id)
      .map((model) => ({
        model: rawModelName(model.id, provider.id),
        displayName: model.displayName ?? '',
        maxContextSize: model.maxContextSize,
      }));
    form.models = rows.length > 0 ? rows : [emptyRow()];
    formError.value = '';
    formOpen.value = true;
  } finally {
    editLoading.value = false;
  }
}

function cancelForm(): void {
  if (props.embedded) {
    const fallback =
      props.providers.find((provider) => provider.id === editingId.value) ?? props.providers[0];
    if (fallback) void openEdit(fallback);
    else formOpen.value = false;
    return;
  }
  formOpen.value = false;
}

function addModelRow(): void {
  form.models.push(emptyRow());
}

function removeModelRow(index: number): void {
  form.models.splice(index, 1);
}

async function submitForm(): Promise<void> {
  const id = form.id.trim();
  if (!id) {
    formError.value = t('providers.idRequired');
    return;
  }
  const models = form.models
    .map((row) => ({
      model: row.model.trim(),
      displayName: row.displayName.trim() || undefined,
      maxContextSize: Math.floor(Number(row.maxContextSize)),
    }))
    .filter((row) => row.model.length > 0);
  if (models.length === 0 || models.some((row) => !Number.isFinite(row.maxContextSize) || row.maxContextSize < 1)) {
    formError.value = t('providers.modelsRequired');
    return;
  }
  if (editingId.value === undefined && !form.apiKey.trim()) {
    formError.value = t('providers.apiKeyRequired');
    return;
  }
  formError.value = '';
  const apiKey = form.apiKey.trim();
  const input: AppProviderInput = {
    id,
    type: form.type,
    // Replace semantics: an absent api_key keeps the stored one, so an empty
    // input in edit mode means "keep".
    apiKey: apiKey === '' ? undefined : apiKey,
    baseUrl: form.baseUrl.trim() || undefined,
    defaultModel: form.defaultModel.trim() || undefined,
    models,
  };
  formBusy.value = true;
  try {
    const saved = await props.save(input, editingId.value);
    if (saved) {
      if (props.embedded) {
        editingId.value = id;
        hasStoredKey.value = true;
      } else {
        formOpen.value = false;
      }
    }
  } finally {
    formBusy.value = false;
  }
}

// -------------------------------------------------------------------------
// Keyboard — Esc closes
// -------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
  if (props.embedded) return;
  if (e.key === 'Escape') {
    if (formOpen.value) { cancelForm(); return; }
    emit('close');
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));

// The embedded settings layout always keeps a useful detail pane visible:
// select the first configured provider, or present the add-provider form when
// the catalog is empty. When a selected provider is deleted, move to the next
// available row instead of leaving a dead detail view behind.
watch(
  [
    () => props.embedded,
    () => props.loading,
    () => props.unavailable,
    () => props.providers,
  ],
  ([embedded, loading, unavailable, providers]) => {
    if (!embedded || loading || unavailable) return;
    const selectedStillExists =
      editingId.value !== undefined && providers.some((provider) => provider.id === editingId.value);
    if (formOpen.value && (editingId.value === undefined || selectedStillExists)) return;
    const first = providers[0];
    if (first) void openEdit(first);
    else openAdd();
  },
  { immediate: true },
);

// -------------------------------------------------------------------------
// Status helpers
// -------------------------------------------------------------------------

function statusColor(status: AppProvider['status']): string {
  if (status === 'connected') return 'var(--color-success)';
  if (status === 'error') return 'var(--color-danger)';
  return 'var(--color-text-faint)';
}
function statusLabel(status: AppProvider['status']): string {
  if (status === 'connected') return t('providers.status.connected');
  if (status === 'error') return t('providers.status.error');
  return t('providers.status.unconfigured');
}
</script>

<template>
  <component
    :is="embedded ? 'div' : Dialog"
    :open="embedded ? undefined : true"
    :close-on-esc="embedded ? undefined : false"
    :title="embedded ? undefined : t('providers.title')"
    :size="embedded ? undefined : 'xl'"
    :height="embedded ? undefined : 'fixed'"
    :class="{ 'provider-manager-surface': embedded }"
    @close="emit('close')"
  >
    <div ref="dialogRef" class="pm" :class="{ 'pm--embedded': embedded }">
      <Button v-if="!embedded && !formOpen" variant="ghost" size="sm" class="page-back-button" @click="emit('close')">
        <Icon name="undo" size="sm" />
        {{ t('providers.backToApp') }}
      </Button>
      <div v-if="embedded || !formOpen" class="manager-head">
        <div>
          <div class="manager-kicker">{{ t('providers.accessKicker') }}</div>
          <p class="manager-copy">{{ t('providers.accessHint') }}</p>
        </div>
        <div class="manager-actions">
          <Button variant="secondary" size="sm" @click="openDeepSeek">
            <Icon name="sparkles" size="sm" />
            {{ t('providers.addDeepSeek') }}
          </Button>
          <Button v-if="!embedded" variant="primary" size="sm" @click="openAdd">
            <Icon name="plus" size="sm" />
            {{ t('providers.addCustom') }}
          </Button>
        </div>
      </div>

      <!-- Provider list -->
      <div v-if="embedded || !formOpen" class="prov-list">
        <!-- Loading state — a content-shaped ghost of the provider rows
             (breathing lives in Skeleton.vue's own scoped styles). -->
        <div v-if="loading" class="prov-loading">
          <div class="prov-skel" aria-hidden="true">
            <div v-for="n in 3" :key="n" class="prov-skel-row">
              <Skeleton circle width="8px" height="8px" />
              <div class="prov-skel-info">
                <Skeleton width="36%" height="12px" />
                <Skeleton width="22%" height="9px" />
              </div>
              <div class="prov-skel-actions">
                <Skeleton width="52px" height="22px" />
                <Skeleton width="66px" height="22px" />
                <Skeleton width="56px" height="22px" />
              </div>
            </div>
          </div>
          <span class="prov-loading-text">{{ t('providers.loading') }}</span>
        </div>
        <!-- Unavailable (daemon 404) -->
        <div v-else-if="unavailable" class="state-row unavail">
          <Icon name="alert-triangle" size="md" />
          <span>{{ t('providers.unavailable') }}</span>
        </div>
        <!-- Empty — design-system EmptyState with a connect hint. -->
        <EmptyState v-else-if="providers.length === 0" class="prov-empty" :title="t('providers.empty')">
          <template #icon><Icon name="globe" size="lg" /></template>
        </EmptyState>
        <!-- Provider rows -->
        <template v-else>
          <div
            v-for="p in providers"
            :key="p.id"
            class="prov-row"
            :class="{ 'prov-row--active': embedded && editingId === p.id && formOpen }"
            :role="embedded ? 'button' : undefined"
            :tabindex="embedded ? 0 : undefined"
            @click="embedded && openEdit(p)"
            @keydown.enter.prevent="embedded && openEdit(p)"
            @keydown.space.prevent="embedded && openEdit(p)"
          >
            <!-- Status dot -->
            <Tooltip :text="statusLabel(p.status)">
              <span
                class="status-dot"
                :class="{ 'status-dot--empty': p.status !== 'connected' && p.status !== 'error' }"
                :style="p.status === 'connected' || p.status === 'error' ? { background: statusColor(p.status) } : undefined"
              />
            </Tooltip>
            <div class="prov-info">
              <span class="prov-type">{{ p.id }} <span class="prov-proto">({{ p.type }})</span></span>
              <span v-if="p.baseUrl" class="prov-url">{{ p.baseUrl }}</span>
              <span class="prov-meta">
                <Badge :variant="p.hasApiKey ? 'success' : 'neutral'" size="sm">
                  {{ p.hasApiKey ? t('providers.keySet') : t('providers.keyNotSet') }}
                </Badge>
                <span v-if="p.models && p.models.length > 0"> · {{ t('providers.modelCount', { count: p.models.length }) }}</span>
              </span>
              <span v-if="p.models && p.models.length > 0" class="prov-models">
                {{ p.models.slice(0, 3).join(' · ') }}{{ p.models.length > 3 ? ' · …' : '' }}
              </span>
            </div>
            <!-- Actions -->
            <div v-if="!embedded" class="prov-actions">
              <Tooltip :text="t('providers.editTitle', { type: p.id })">
                <Button variant="secondary" size="sm" :disabled="editLoading" @click="openEdit(p)">{{ t('providers.edit') }}</Button>
              </Tooltip>
              <Tooltip :text="t('providers.refreshTitle', { type: p.id })">
                <Button variant="secondary" size="sm" @click="emit('refresh', p.id)">{{ t('providers.refresh') }}</Button>
              </Tooltip>
              <Tooltip :text="t('providers.deleteTitle', { type: p.id })">
                <Button variant="danger-soft" size="sm" @click="onDeleteProvider(p.id)">{{ t('providers.delete') }}</Button>
              </Tooltip>
            </div>
          </div>
        </template>
        <button
          v-if="embedded && !loading && !unavailable"
          type="button"
          class="provider-add-row"
          :class="{ 'provider-add-row--active': editingId === undefined && formOpen }"
          @click="openAdd"
        >
          <Icon name="plus" size="sm" />
          <span>{{ t('providers.addProvider') }}</span>
        </button>
      </div>

      <!-- Add buttons / create-edit form -->
      <div v-if="!unavailable" class="add-section" :class="{ 'add-section--form': formOpen }">
        <template v-if="!formOpen">
          <div v-if="embedded" class="detail-placeholder">
            <Icon name="settings" size="lg" />
            <span>{{ t('providers.selectProvider') }}</span>
          </div>
          <div v-else class="add-btns">
            <!-- OAuth login shortcuts for common platforms -->
            <Button variant="secondary" size="sm" @click="emit('openLogin', 'moonshot')">
              <Icon name="user" size="sm" />
              {{ t('providers.loginKimi') }}
            </Button>
            <Button variant="secondary" size="sm" @click="emit('openLogin', 'anthropic')">
              <Icon name="user" size="sm" />
              {{ t('providers.loginAnthropic') }}
            </Button>
          </div>
        </template>
        <template v-else>
          <div class="add-form">
            <div class="form-head">
              <div>
                <div class="form-title">
                  {{ editingId === undefined ? t('providers.addProvider') : t('providers.editProvider') }}
                </div>
                <p class="form-subtitle">{{ t('providers.accessHint') }}</p>
              </div>
              <div class="form-head-actions">
                <Button
                  v-if="embedded && editingId !== undefined"
                  variant="secondary"
                  size="sm"
                  :disabled="formBusy"
                  @click="emit('refresh', editingId)"
                >
                  {{ t('providers.refresh') }}
                </Button>
                <Button
                  v-if="embedded && editingId !== undefined"
                  variant="danger-soft"
                  size="sm"
                  :disabled="formBusy"
                  @click="onDeleteProvider(editingId)"
                >
                  {{ t('providers.delete') }}
                </Button>
                <Button variant="ghost" size="sm" :disabled="formBusy" @click="cancelForm">
                  {{ t('common.cancel') }}
                </Button>
              </div>
            </div>

            <section class="form-section">
              <div class="section-title">{{ t('providers.accessKicker') }}</div>
              <div class="form-grid">
                <Field :label="t('providers.fieldId')">
                  <Input
                    v-model="form.id"
                    :placeholder="t('providers.idPlaceholder')"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </Field>
                <Field :label="t('providers.fieldType')">
                  <Select v-model="form.type">
                    <option v-for="pt in PROVIDER_TYPES" :key="pt" :value="pt">{{ pt }}</option>
                  </Select>
                </Field>
              </div>
              <Field
                :label="t('providers.fieldApiKey')"
                :hint="editingId !== undefined && hasStoredKey
                  ? t('providers.apiKeyVisibleHint')
                  : undefined"
              >
                <div class="api-key-control">
                  <Input
                    v-model="form.apiKey"
                    :type="showApiKey ? 'text' : 'password'"
                    placeholder="sk-…"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    :aria-label="showApiKey ? t('providers.hideApiKey') : t('providers.showApiKey')"
                    :title="showApiKey ? t('providers.hideApiKey') : t('providers.showApiKey')"
                    @click="showApiKey = !showApiKey"
                  >
                    <Icon :name="showApiKey ? 'eye-off' : 'eye'" size="sm" />
                  </Button>
                </div>
              </Field>
              <Field :label="t('providers.fieldBaseUrl')">
                <Input
                  v-model="form.baseUrl"
                  :placeholder="t('providers.baseUrlPlaceholder')"
                  autocomplete="off"
                  spellcheck="false"
                />
              </Field>
            </section>

            <!-- Model list: name / display name / max context size -->
            <section class="form-section model-section">
              <div class="section-head">
                <div>
                  <div class="models-heading">{{ t('providers.modelsHeading') }}</div>
                  <div class="section-hint">{{ t('providers.defaultModelHint') }}</div>
                </div>
                <Button variant="secondary" size="sm" @click="addModelRow">
                  <Icon name="plus" size="sm" />
                  {{ t('providers.addModel') }}
                </Button>
              </div>
              <div class="model-rows">
                <div class="model-row model-row--head">
                  <span>{{ t('providers.modelName') }}</span>
                  <span>{{ t('providers.modelDisplayName') }}</span>
                  <span>{{ t('providers.modelContextSize') }}</span>
                  <span />
                </div>
                <div v-for="(row, index) in form.models" :key="index" class="model-row">
                  <Input
                    v-model="row.model"
                    :placeholder="t('providers.modelNamePlaceholder')"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <Input
                    v-model="row.displayName"
                    :placeholder="t('providers.optional')"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <Input
                    v-model.number="row.maxContextSize"
                    type="number"
                    min="1"
                    autocomplete="off"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    :disabled="form.models.length <= 1"
                    :aria-label="t('providers.removeModel')"
                    @click="removeModelRow(index)"
                  >
                    <Icon name="minus" size="sm" />
                  </Button>
                </div>
              </div>
            </section>

            <section class="form-section form-section--default">
              <Field :label="t('providers.fieldDefaultModel')" :hint="t('providers.defaultModelHint')">
                <Select v-model="form.defaultModel">
                  <option value="">{{ t('providers.optional') }}</option>
                  <option v-for="row in form.models.filter((item) => item.model.trim())" :key="row.model" :value="row.model.trim()">
                    {{ row.displayName.trim() || row.model.trim() }}
                  </option>
                </Select>
              </Field>
            </section>

            <!-- Validation / save failure. `role="alert"` falls through onto
                 Banner's root (overriding its default polite `status`) so
                 failures announce assertively — same precedent as
                 AddWorkspaceDialog. -->
            <Banner v-if="formError" variant="danger" class="add-error" role="alert">{{ formError }}</Banner>
            <div class="form-btns">
              <Button variant="primary" size="sm" :disabled="formBusy" @click="submitForm">
                <Spinner v-if="formBusy" size="sm" />
                {{ editingId === undefined ? t('providers.add') : t('providers.save') }}
              </Button>
            </div>
          </div>
        </template>
      </div>

      <!-- Footer -->
      <div v-if="!embedded" class="footer-hint">{{ t('providers.escClose') }}</div>
    </div>
  </component>
</template>

<style scoped>
.pm { display: flex; flex-direction: column; gap: var(--space-4); }
.provider-manager-surface {
  display: block;
  height: 100%;
  min-width: 0;
}
.pm--embedded {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xl);
  background: var(--color-surface-raised);
}
.pm--embedded .manager-head {
  grid-column: 1 / -1;
  margin: 0;
  padding: var(--space-4) var(--space-5);
}
.pm--embedded .prov-list {
  grid-column: 1;
  grid-row: 2;
  min-width: 0;
  overflow-y: auto;
  padding: var(--space-3);
  border-inline-end: 1px solid var(--color-line);
  background: var(--color-surface);
}
.pm--embedded .add-section {
  grid-column: 2;
  grid-row: 2;
  min-width: 0;
  overflow-y: auto;
  padding: var(--space-5);
  border-top: none;
}
.pm--embedded .prov-row {
  width: 100%;
  min-height: 50px;
  padding: var(--space-3);
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  text-align: start;
  cursor: pointer;
}
.pm--embedded .prov-row:hover { background: var(--color-surface-sunken); }
.pm--embedded .prov-row--active {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.pm--embedded .prov-row:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.provider-add-row {
  display: inline-flex;
  width: 100%;
  min-height: 40px;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.provider-add-row:hover { border-color: var(--color-line-strong); }
.provider-add-row--active {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.provider-add-row:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.pm--embedded .prov-url,
.pm--embedded .prov-meta,
.pm--embedded .prov-models { display: none; }
.pm--embedded .prov-proto {
  display: block;
  margin-top: 2px;
  font-size: var(--text-xs);
}

.manager-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.page-back-button {
  align-self: flex-start;
  margin-bottom: calc(var(--space-2) * -1);
  padding-left: 0;
  color: var(--color-text-muted);
}
.manager-kicker {
  margin-bottom: var(--space-1);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}
.manager-copy {
  max-width: 480px;
  margin: 0;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.manager-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* Provider list */
.prov-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.state-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) 0;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
.state-row.unavail { color: var(--color-warning); }
/* Loading ghost — mirrors the provider-row shape (dot / info / actions) so a
   loading list already reads as provider-shaped. */
.prov-loading {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  animation: kimi-card-in var(--duration-slow) var(--ease-out) both;
}
.prov-skel {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.prov-skel-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-line);
}
.prov-skel-row:last-child { border-bottom: none; }
.prov-skel-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.prov-skel-actions {
  display: flex;
  flex: none;
  gap: var(--space-2);
}
.prov-loading-text {
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
}
/* Empty state — same one-shot entrance as the loading ghost. */
.prov-empty { animation: kimi-card-in var(--duration-slow) var(--ease-out) both; }
.prov-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-line);
  transition: background var(--duration-fast) var(--ease-out);
  animation: kimi-card-in var(--duration-slow) var(--ease-out) both;
}
.prov-row:last-child { border-bottom: none; }
/* Gentle cascade for the list entrance (the global reduced-motion kill-switch
   in style.css zeroes these delays). */
.prov-row:nth-child(2) { animation-delay: 30ms; }
.prov-row:nth-child(3) { animation-delay: 60ms; }
.prov-row:nth-child(4) { animation-delay: 90ms; }
.prov-row:nth-child(5) { animation-delay: 120ms; }

.status-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  box-sizing: border-box;
}
.status-dot--empty {
  background: transparent;
  border: 1.5px solid var(--color-text-faint);
}
.prov-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.prov-type {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.prov-proto {
  font-weight: var(--weight-regular);
  color: var(--color-text-muted);
}
.prov-url {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prov-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.prov-models {
  overflow: hidden;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prov-actions {
  display: flex;
  gap: var(--space-2);
  flex: none;
  align-items: center;
  flex-wrap: wrap;
}
/* Add section */
.add-section {
  border-top: 1px solid var(--color-line);
  padding-top: var(--space-4);
}
.add-section--form { border-top: none; padding-top: 0; }
.add-btns {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* Form */
.add-form { display: flex; flex-direction: column; gap: var(--space-4); }
.form-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.form-head-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
.form-title {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--color-text);
}
.form-subtitle {
  max-width: 560px;
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.api-key-control {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.api-key-control .ui-input { min-width: 0; }
.api-key-control .ui-button { flex: none; }
.form-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}
.section-title,
.models-heading {
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}
.section-hint {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.form-section--default { background: var(--color-surface-sunken); }
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
.model-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.model-row {
  display: grid;
  grid-template-columns: 1.2fr 1fr 0.8fr auto;
  gap: var(--space-2);
  align-items: center;
}
.model-row:not(.model-row--head) {
  padding: var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.model-row--head {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
/* .add-error is the danger Banner — token colors/typography live in
   Banner.vue; the surrounding .add-form gap supplies the spacing. */
.form-btns {
  position: sticky;
  bottom: calc(-1 * var(--space-4));
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0 calc(-1 * var(--space-5)) calc(-1 * var(--space-4));
  padding: var(--space-3) var(--space-5) var(--space-2);
  border-top: 1px solid var(--color-line);
  background: var(--color-surface-raised);
  z-index: 1;
}
.detail-placeholder {
  display: flex;
  min-height: 320px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

/* Footer */
.footer-hint {
  padding-top: var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  border-top: 1px solid var(--color-line);
}

@media (max-width: 640px) {
  .manager-head {
    flex-direction: column;
  }
  .manager-actions {
    width: 100%;
  }
  .prov-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .prov-actions {
    flex: 1 1 100%;
    justify-content: flex-end;
  }
  .prov-skel-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .prov-skel-actions {
    flex: 1 1 100%;
    justify-content: flex-end;
  }
  .form-grid { grid-template-columns: 1fr; }
  .form-head,
  .section-head { flex-direction: column; }
  .form-head > .ui-button,
  .section-head > .ui-button { align-self: flex-start; }
  .api-key-control { align-items: stretch; flex-direction: column; }
  .api-key-control .ui-button { align-self: flex-start; }
  .model-row { grid-template-columns: 1fr 1fr 0.9fr auto; }
}

@media (max-width: 980px) {
  .pm--embedded {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto minmax(0, 1fr);
  }
  .pm--embedded .manager-head { grid-column: 1; }
  .pm--embedded .prov-list {
    grid-column: 1;
    grid-row: 2;
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    border-inline-end: 0;
    border-bottom: 1px solid var(--color-line);
  }
  .pm--embedded .prov-row {
    min-width: 180px;
    width: auto;
  }
  .pm--embedded .add-section {
    grid-column: 1;
    grid-row: 3;
  }
}

@media (max-width: 640px) {
  .pm--embedded {
    min-height: 0;
    border-radius: var(--radius-lg);
  }
  .pm--embedded .manager-head,
  .pm--embedded .add-section { padding: var(--space-4); }
  .form-head-actions { justify-content: flex-start; }
  .model-row,
  .model-row.model-row--head { grid-template-columns: 1fr; }
  .model-row--head { display: none; }
}
</style>
