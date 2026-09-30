export type QueryResult<T> = { data: T; error: null } | { data: null; error: string };

// Stay below PostgREST's default 1,000-row response limit.
const PAGE_SIZE = 500;

/** Read every page of a query with a stable, unique ordering. */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<QueryResult<T[]>> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error: error.message };
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_SIZE) return { data: rows, error: null };
  }
}
