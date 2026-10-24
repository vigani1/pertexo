export type RunListVariant = 'workspace' | 'workflow';

type RowLayout = Readonly<{
  grid: string;
  link: string;
  trigger: string;
  started: string;
  took: string;
  bar: string;
  id: string;
  menu: string;
}>;

/**
 * Where each fact sits from `md` up. A tablet gets the table without the
 * trigger and thread bar; from `lg` every column shows. The workspace log
 * names the workflow and shows when each run started; inside a workflow the
 * start time is the name.
 */
export const RUN_ROW_LAYOUT: Readonly<Record<RunListVariant, RowLayout>> = {
  workspace: {
    grid: 'md:grid-cols-[8.5rem_minmax(8rem,1fr)_5.5rem_5rem_6.5rem_2rem] lg:grid-cols-[9.25rem_minmax(8rem,1fr)_6.5rem_6.5rem_5.5rem_minmax(4rem,7rem)_6.5rem_2rem]',
    link: 'md:col-start-2',
    trigger: 'max-lg:md:hidden lg:col-start-3',
    started: 'md:col-start-3 lg:col-start-4',
    took: 'md:col-start-4 lg:col-start-5',
    bar: 'max-lg:md:hidden lg:col-start-6',
    id: 'md:col-start-5 lg:col-start-7',
    menu: 'md:col-start-6 lg:col-start-8',
  },
  workflow: {
    grid: 'md:grid-cols-[8.5rem_minmax(7rem,1fr)_5rem_6.5rem_2rem] lg:grid-cols-[9.25rem_8rem_6.5rem_5.5rem_minmax(4rem,1fr)_6.5rem_2rem]',
    link: 'md:col-start-2',
    trigger: 'max-lg:md:hidden lg:col-start-3',
    started: '',
    took: 'md:col-start-3 lg:col-start-4',
    bar: 'max-lg:md:hidden lg:col-start-5',
    id: 'md:col-start-4 lg:col-start-6',
    menu: 'md:col-start-5 lg:col-start-7',
  },
};
