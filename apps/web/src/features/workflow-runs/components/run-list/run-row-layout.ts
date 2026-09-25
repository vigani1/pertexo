export type RunListVariant = 'workspace' | 'workflow';

type RowLayout = Readonly<{
  grid: string;
  link: string;
  trigger: string;
  took: string;
  bar: string;
  id: string;
  menu: string;
}>;

/**
 * Where each fact sits from `lg` up. The workspace log names the workflow and
 * shows when each run started; inside a workflow the start time is the name.
 */
export const RUN_ROW_LAYOUT: Readonly<Record<RunListVariant, RowLayout>> = {
  workspace: {
    grid: 'lg:grid-cols-[9.25rem_minmax(8rem,1fr)_6.5rem_6.5rem_5.5rem_minmax(4rem,7rem)_6.5rem_2rem]',
    link: 'lg:col-start-2',
    trigger: 'lg:col-start-3',
    took: 'lg:col-start-5',
    bar: 'lg:col-start-6',
    id: 'lg:col-start-7',
    menu: 'lg:col-start-8',
  },
  workflow: {
    grid: 'lg:grid-cols-[9.25rem_8rem_6.5rem_5.5rem_minmax(4rem,1fr)_6.5rem_2rem]',
    link: 'lg:col-start-2',
    trigger: 'lg:col-start-3',
    took: 'lg:col-start-4',
    bar: 'lg:col-start-5',
    id: 'lg:col-start-6',
    menu: 'lg:col-start-7',
  },
};
