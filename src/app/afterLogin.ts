// Keeps the full target of a login (path + query) in this tab while the OAuth round trip only carries the path.
const KEY = 'travelsplit.afterLogin'

export function rememberAfterLogin(target: string) {
  try {
    sessionStorage.setItem(KEY, target)
  } catch {
    /* private mode: the query is lost, the path still works */
  }
}

/** The remembered target if it belongs to the current path without a query; consumed on read. */
export function takeAfterLogin(pathname: string, search: string): string | null {
  try {
    const target = sessionStorage.getItem(KEY)
    if (!target) return null
    sessionStorage.removeItem(KEY)
    return !search && target.split('?')[0] === pathname ? target : null
  } catch {
    return null
  }
}
