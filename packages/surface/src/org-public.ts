/** An owner in the org chart; the tree is drawn from `manager`. */
export interface OrgEntry {
  id: string;
  name: string;
  title: string;
  icon: string;
  domain: string;
  manager?: string;
}
