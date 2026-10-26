import type { ProjectionDto, ProjectionNodeDto } from '../api.ts';

/** Readable table alternative to the canvas (plan §13 accessibility). */
export function ListView({
  projection,
  onOpen,
  onSelect,
}: {
  projection: ProjectionDto;
  onOpen(n: ProjectionNodeDto): void;
  onSelect(n: ProjectionNodeDto): void;
}) {
  const label = new Map(projection.nodes.map((n) => [n.id, n.label]));
  return (
    <div className="list-view">
      <table>
        <caption>Nodes in {projection.title}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Kind</th>
            <th scope="col">Detail</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {projection.nodes
            .filter((n) => n.kind !== 'group')
            .map((n) => (
              <tr key={n.id}>
                <th scope="row">{n.label}</th>
                <td>{n.entityKind ?? n.kind}</td>
                <td>
                  {n.sublabel}
                  {n.lifecycle && n.lifecycle !== 'active' ? ` · ${n.lifecycle}` : ''}
                  {n.change ? ` · ${n.change}` : ''}
                </td>
                <td>
                  <button type="button" className="link" onClick={() => onSelect(n)}>
                    Inspect
                  </button>
                  {(n.focus !== undefined || n.openCanvasId) && (
                    <button type="button" className="link" onClick={() => onOpen(n)}>
                      Open
                    </button>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <table>
        <caption>Relations</caption>
        <thead>
          <tr>
            <th scope="col">From</th>
            <th scope="col">Relation</th>
            <th scope="col">To</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {projection.edges.map((e) => (
            <tr key={e.id}>
              <td>{label.get(e.source)}</td>
              <td>
                {Object.entries(e.kinds)
                  .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
                  .join(', ')}
              </td>
              <td>{label.get(e.target)}</td>
              <td>{e.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
