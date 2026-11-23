import {
  CLASSIFY_CATEGORY_LIMITS,
  CLASSIFY_CATEGORY_PORTS,
  type ClassifyCategory,
} from '@pertexo/workflow-model';
import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCount } from '@/lib/format/count';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import {
  readClassifyCategories,
  validateClassifyCategoryEdit,
} from '../../../model/classify-categories';
import { moved } from '../../../model/inspector/setup-builders';
import { BuilderCard, EntryActions, LiveTextField } from './parts';

export function ClassifyCategories({
  categories,
  linkedPorts,
  form,
}: Readonly<{
  categories: readonly ClassifyCategory[];
  linkedPorts: ReadonlySet<string>;
  form: NodeFormApi;
}>) {
  function change(
    update: (
      current: readonly ClassifyCategory[],
    ) => readonly ClassifyCategory[],
    key: string,
  ) {
    form.commit(
      (node) => ({
        config: {
          ...node.config,
          categories: [
            ...update(readClassifyCategories(node.config) ?? categories),
          ],
        },
      }),
      `${form.nodeId}:config:categories:${key}`,
    );
  }
  const available = CLASSIFY_CATEGORY_PORTS.find(
    (id) => !categories.some((category) => category.id === id),
  );
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium">Categories</legend>
      <p className="-mt-1 text-xs leading-relaxed text-muted-foreground">
        The model receives the mapped text and these category definitions. Text
        that fits no category goes to Other.
      </p>
      <ol className="flex flex-col gap-2">
        {categories.map((category, index) => (
          <BuilderCard
            key={category.id}
            title={category.label}
            port={category.id}
            actions={
              <EntryActions
                label={category.label}
                first={index === 0}
                last={index === categories.length - 1}
                canRemove={categories.length > 1}
                removeHint="Classify needs at least one category."
                editable={form.editable}
                onMove={(by) => {
                  change((current) => moved(current, index, by), 'order');
                }}
                onRemove={() => {
                  change(
                    (current) => current.filter(({ id }) => id !== category.id),
                    'remove',
                  );
                }}
              />
            }
          >
            <CategoryFields
              category={category}
              categories={categories}
              form={form}
              update={(field, value) => {
                change(
                  (current) =>
                    current.map((entry) =>
                      entry.id === category.id
                        ? { ...entry, [field]: value }
                        : entry,
                    ),
                  `${category.id}:${field}`,
                );
              }}
            />
            {categories.length > 1 && linkedPorts.has(category.id) ? (
              <p className="text-xs text-muted-foreground">
                Removing this category also removes its outgoing links.
              </p>
            ) : null}
          </BuilderCard>
        ))}
      </ol>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit"
        disabled={!form.editable || available === undefined}
        onClick={() => {
          if (available === undefined) return;
          change((current) => {
            const labels = new Set(
              current.map(({ label }) => label.toLowerCase()),
            );
            let number = current.length + 1;
            while (labels.has(`category ${String(number)}`)) number += 1;
            return [
              ...current,
              {
                id: available,
                label: `Category ${String(number)}`,
                description: 'Describe which text belongs in this category.',
              },
            ];
          }, 'add');
        }}
      >
        <PlusIcon data-icon="inline-start" />
        Add category
      </Button>
    </fieldset>
  );
}

function CategoryFields({
  category,
  categories,
  form,
  update,
}: Readonly<{
  category: ClassifyCategory;
  categories: readonly ClassifyCategory[];
  form: NodeFormApi;
  update: (field: 'label' | 'description', value: string) => void;
}>) {
  return (['label', 'description'] as const).map((field) => {
    const limit =
      field === 'label'
        ? CLASSIFY_CATEGORY_LIMITS.labelCharacters
        : CLASSIFY_CATEGORY_LIMITS.descriptionCharacters;
    const key = `categories.${category.id}.${field}`;
    return (
      <LiveTextField<string>
        key={field}
        form={form}
        scratchKey={key}
        binding={{
          value: category[field],
          format: (value) => value,
          parse: (text) => {
            const edit = validateClassifyCategoryEdit(
              categories,
              category,
              field,
              text,
            );
            if (edit.ok) return edit;
            const errors = {
              empty: 'Enter a value.',
              too_long: `Use at most ${formatCount(limit, 'character')}.`,
              duplicate: 'Use a unique category name.',
              invalid: 'Enter a valid category value.',
            };
            return { ok: false, error: errors[edit.reason] };
          },
          onCommit: (value) => {
            update(field, value);
          },
        }}
        input={{
          id: fieldControlId(form.nodeId, key),
          label: field === 'label' ? 'Category name' : 'Description',
        }}
      />
    );
  });
}
