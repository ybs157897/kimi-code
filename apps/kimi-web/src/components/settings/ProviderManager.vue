<!-- apps/kimi-web/src/components/settings/ProviderManager.vue -->
<!-- Modal overlay for managing providers: list, create/edit (with per-model
     context sizes), refresh, delete. -->
<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppModel, AppProvider, AppProviderDetail, AppProviderInput } from '../../api/types';
import { useDialogFocus } from '../../composables/useDialogFocus';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Badge from '../ui/Badge.vue';
import Spinner from '../ui/Spinner.vue';
import Field from '../ui/Field.vue';
import Input from '../ui/Input.vue';
import Select from '../ui/Select.vue';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';

const { t } = useI18n();

const dialogRef = ref<HTMLElement | null>(null);
// Move focus into the dialog on open; restore it to the opener on close.
useDialogFocus(dialogRef);

const props = defineProps<{
  providers: AppProvider[];
  /** Model catalog — prefills the edit form's model rows for a provider. */
  models: AppModel[];
  loading?: boolean;
  /** If true, providers could not be fetched (daemon 404 / unsupported) */
  unavailable?: boolean;
  /** Full single-provider read (stored api key included) for edit prefill. */
  loadDetail: (id: string) => Promise<AppProviderDetail | null>;
  /** Create (existingId undefined) or replace a provider. True = saved. */
  save: (input: AppProviderInput, existingId?: string) => Promise<boolean>;
}>();

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
    form.id = detail.id;
    form.type = detail.type;
    // The stored key prefills the input so it round-trips unchanged on save;
    // clearing the field keeps it (see submit()).
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
    if (saved) formOpen.value = false;
  } finally {
    formBusy.value = false;
  }
}

// -------------------------------------------------------------------------
// Keyboard — Esc closes
// -------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (formOpen.value) { cancelForm(); return; }
    emit('close');
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));

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
  <Dialog :open="true" :close-on-esc="false" :title="t('providers.title')" size="xl" height="fixed" @close="emit('close')">
    <div ref="dialogRef" class="pm">
      <div v-if="!formOpen" class="manager-head">
        <div>
          <div class="manager-kicker">{{ t('providers.accessKicker') }}</div>
          <p class="manager-copy">{{ t('providers.accessHint') }}</p>
        </div>
        <div class="manager-actions">
          <Button variant="secondary" size="sm" @click="openDeepSeek">
            <Icon name="sparkles" size="sm" />
            {{ t('providers.addDeepSeek') }}
          </Button>
          <Button variant="primary" size="sm" @click="openAdd">
            <Icon name="plus" size="sm" />
            {{ t('providers.addCustom') }}
          </Button>
        </div>
      </div>

      <!-- Provider list -->
      <div v-if="!formOpen" class="prov-list">
        <!-- Loading state -->
        <div v-if="loading" class="state-row">
          <Spinner size="sm" />
          <span>{{ t('providers.loading') }}</span>
        </div>
        <!-- Unavailable (daemon 404) -->
        <div v-else-if="unavailable" class="state-row unavail">
          <Icon name="alert-triangle" size="md" />
          <span>{{ t('providers.unavailable') }}</span>
        </div>
        <!-- Empty -->
        <div v-else-if="providers.length === 0" class="empty">{{ t('providers.empty') }}</div>
        <!-- Provider rows -->
        <template v-else>
          <div v-for="p in providers" :key="p.id" class="prov-row">
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
            </div>
            <!-- Actions -->
            <div class="prov-actions">
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
      </div>

      <!-- Add buttons / create-edit form -->
      <div v-if="!unavailable" class="add-section" :class="{ 'add-section--form': formOpen }">
        <template v-if="!formOpen">
          <div class="add-btns">
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
            <div class="form-title">
              {{ editingId === undefined ? t('providers.addProvider') : t('providers.editProvider') }}
            </div>
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
            <Field :label="t('providers.fieldApiKey')" :hint="editingId !== undefined && hasStoredKey ? t('providers.apiKeyKeepHint') : undefined">
              <Input
                v-model="form.apiKey"
                type="password"
                placeholder="sk-…"
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
            <Field :label="t('providers.fieldBaseUrl')">
              <Input
                v-model="form.baseUrl"
                :placeholder="t('providers.baseUrlPlaceholder')"
                autocomplete="off"
                spellcheck="false"
              />
            </Field>

            <!-- Model list: name / display name / max context size -->
            <div class="models-heading">{{ t('providers.modelsHeading') }}</div>
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
              <div>
                <Button variant="secondary" size="sm" @click="addModelRow">
                  <Icon name="plus" size="sm" />
                  {{ t('providers.addModel') }}
                </Button>
              </div>
            </div>

            <Field :label="t('providers.fieldDefaultModel')" :hint="t('providers.defaultModelHint')">
              <Input
                v-model="form.defaultModel"
                :placeholder="t('providers.optional')"
                autocomplete="off"
                spellcheck="false"
              />
            </Field>

            <div v-if="formError" class="add-error">{{ formError }}</div>
            <div class="form-btns">
              <Button variant="primary" size="sm" :disabled="formBusy" @click="submitForm">
                <Spinner v-if="formBusy" size="sm" />
                {{ editingId === undefined ? t('providers.add') : t('providers.save') }}
              </Button>
              <Button variant="secondary" size="sm" :disabled="formBusy" @click="cancelForm">{{ t('common.cancel') }}</Button>
            </div>
          </div>
        </template>
      </div>

      <!-- Footer -->
      <div class="footer-hint">{{ t('providers.escClose') }}</div>
    </div>
  </Dialog>
</template>

<style scoped>
.pm { display: flex; flex-direction: column; gap: var(--space-4); }

.manager-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-line);
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
.empty {
  padding: var(--space-4) 0;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
.prov-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-line);
  transition: background var(--duration-fast) var(--ease-out);
}
.prov-row:last-child { border-bottom: none; }

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
.add-form { display: flex; flex-direction: column; gap: var(--space-3); }
.form-title {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--color-text);
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
.models-heading {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--color-text);
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
.model-row--head {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.add-error {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-danger);
}
.form-btns {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
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
  .form-grid { grid-template-columns: 1fr; }
  .model-row { grid-template-columns: 1fr 1fr 0.9fr auto; }
}
</style>
