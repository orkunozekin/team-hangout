import { formatDateTime } from "../../shared/dates";
import { useEffect, useRef, useState } from "react";
import type {
  Facility,
  FacilityFields,
  Resource,
  ResourceFields,
  Availability,
} from "../../shared/facilities";
import type { BrowserServices } from "./firebase";
import { Mutation } from "./Mutation";
import { errorCode, message } from "./errors";

type Props = { services: BrowserServices; orgId: string };
function useReadEpoch() {
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  return epoch;
}
export function Facilities({ services, orgId }: Props) {
  const epoch = useReadEpoch();
  const capabilityRead = useRef(0);
  const [items, setItems] = useState<Facility[] | null>(null),
    [cursor, setCursor] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false),
    [selected, setSelected] = useState<Facility | null>(null);
  const [editing, setEditing] = useState<Facility | "new" | null>(null),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  const denied = () => {
    epoch.current++;
    setCursor(null);
    setItems(null);
    setSelected(null);
    setEditing(null);
    setCanManage(false);
    setError("Access unavailable. Reload to recheck your staff access.");
  };
  const failed = (e: unknown) =>
    ["functions/permission-denied", "functions/unauthenticated"].includes(
      errorCode(e),
    )
      ? denied()
      : setError(message(e));
  useEffect(() => {
    let alive = true;
    const request = epoch.current;
    const capabilityRequest = ++capabilityRead.current;
    setItems(null);
    setError("");
    setSelected(null);
    setEditing(null);
    services
      .call("listFacilities", { orgId })
      .then((result) => {
        if (alive && request === epoch.current) {
          setItems(result.items);
          setCursor(result.nextCursor);
          if (capabilityRequest === capabilityRead.current)
            setCanManage(result.canManage);
        }
      })
      .catch((e) => {
        if (alive && request === epoch.current) failed(e);
      });
    return () => {
      alive = false;
    };
  }, [services, orgId, version]);
  useEffect(() => {
    let alive = true;
    const check = () => {
      const request = epoch.current;
      const capabilityRequest = ++capabilityRead.current;
      return services
        .call("listFacilities", { orgId, pageSize: 1 })
        .then((result) => {
          if (
            alive &&
            request === epoch.current &&
            capabilityRequest === capabilityRead.current
          ) {
            setCanManage(result.canManage);
            if (!result.canManage) {
              setEditing(null);
            }
          }
        })
        .catch((e) => {
          if (alive && request === epoch.current) failed(e);
        });
    };
    window.addEventListener("focus", check);
    return () => {
      alive = false;
      window.removeEventListener("focus", check);
    };
  }, [services, orgId]);
  const saved = () => {
    epoch.current++;
    setVersion((n) => n + 1);
  };
  return (
    <main id="main-content" tabIndex={-1} className="page facilities">
      <a href={`/organizations/${orgId}/program`}>Back to workspace</a>
      <p className="eyebrow">League operations</p>
      <h1>Facilities and resources</h1>
      <p className="muted">
        Choose the exact field or court. Availability includes setup and cleanup
        time. Organization administrators manage this shared catalog.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button onClick={saved}>Reload facilities</button>
      {items === null && !error ? (
        <p role="status">Loading facilities…</p>
      ) : items?.length === 0 ? (
        <p>No facilities yet.</p>
      ) : null}
      {canManage && (
        <button onClick={() => setEditing("new")}>New facility</button>
      )}
      <div className="org-grid">
        {items?.map((item) => (
          <section className="panel" key={item.id}>
            <span className="badge">
              {item.status === "active"
                ? "Available facility"
                : "Unavailable facility"}
            </span>
            <h2>{item.name}</h2>
            <p>{item.address}</p>
            <button
              onClick={() => {
                setSelected(item);
                setEditing(null);
              }}
            >
              Details and resources for {item.name}
            </button>
            {canManage && (
              <button
                onClick={() => {
                  setEditing(item);
                  setSelected(null);
                }}
              >
                Edit {item.name}
              </button>
            )}
          </section>
        ))}
      </div>
      {cursor && (
        <button
          onClick={() => {
            const boundary = cursor;
            const request = epoch.current;
            const capabilityRequest = ++capabilityRead.current;
            void services
              .call("listFacilities", { orgId, cursor: boundary })
              .then((result) => {
                if (request !== epoch.current) return;
                setItems((old) => [...(old || []), ...result.items]);
                setCursor(result.nextCursor);
                if (capabilityRequest === capabilityRead.current)
                  setCanManage(result.canManage);
              })
              .catch((e) => {
                if (request === epoch.current) failed(e);
              });
          }}
        >
          Load more facilities
        </button>
      )}
      {canManage && editing && (
        <FacilityEditor
          key={typeof editing === "string" ? editing : editing.id}
          {...{ services, orgId }}
          item={editing === "new" ? null : editing}
          onSaved={saved}
          onDenied={denied}
        />
      )}
      {selected && (
        <FacilityDetails
          key={selected.id}
          {...{ services, orgId, canManage }}
          facility={selected}
          onDenied={denied}
        />
      )}
    </main>
  );
}
function FacilityEditor({
  services,
  orgId,
  item,
  onSaved,
  onDenied,
}: Props & {
  item: Facility | null;
  onSaved: () => void;
  onDenied: () => void;
}) {
  const [fields, setFields] = useState<FacilityFields>(
    item || {
      name: "",
      address: "",
      timeZone: "",
      latitude: null,
      longitude: null,
      parking: null,
      accessibility: null,
      status: "active",
    },
  );
  const field = (
    key: "name" | "address" | "timeZone" | "parking" | "accessibility",
    label: string,
    required = false,
  ) => (
    <label>
      {label}
      <input
        required={required}
        value={fields[key] || ""}
        onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <section className="panel">
      <h2>{item ? "Edit facility" : "New facility"}</h2>
      <Mutation
        {...{ onSaved, onDenied }}
        action={() => {
          const payload = {
            orgId,
            ...(item ? { facilityId: item.id } : {}),
            expectedRevision: item?.revision ?? 0,
            requestId: crypto.randomUUID(),
            fields: {
              name: fields.name,
              address: fields.address,
              timeZone: fields.timeZone,
              latitude: fields.latitude,
              longitude: fields.longitude,
              parking: fields.parking,
              accessibility: fields.accessibility,
              status: fields.status,
            },
          };
          return () => services.call("saveFacility", payload);
        }}
      >
        {field("name", "Facility name", true)}
        {field("address", "Street address", true)}
        {field("timeZone", "IANA time zone", true)}
        {field("parking", "Parking instructions")}
        {field("accessibility", "Accessibility instructions")}
        {(["latitude", "longitude"] as const).map((key) => (
          <label key={key}>
            {key === "latitude"
              ? "Latitude (optional)"
              : "Longitude (optional)"}
            <input
              type="number"
              step="any"
              value={fields[key] ?? ""}
              onChange={(e) =>
                setFields({
                  ...fields,
                  [key]: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </label>
        ))}
        <label>
          Facility state
          <select
            value={fields.status}
            onChange={(e) =>
              setFields({
                ...fields,
                status: e.target.value as FacilityFields["status"],
              })
            }
          >
            <option value="active">Active</option>
            <option value="inactive">Unavailable</option>
          </select>
        </label>
      </Mutation>
    </section>
  );
}
function FacilityDetails({
  services,
  orgId,
  facility,
  canManage,
  onDenied,
}: Props & { facility: Facility; canManage: boolean; onDenied: () => void }) {
  const epoch = useReadEpoch();
  const [resources, setResources] = useState<Resource[] | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState("");
  const [editing, setEditing] = useState<Resource | "new" | null>(null),
    [selected, setSelected] = useState<Resource | null>(null),
    [version, setVersion] = useState(0);
  useEffect(() => {
    if (!canManage) setEditing(null);
  }, [canManage]);
  const failed = (e: unknown) =>
    ["functions/permission-denied", "functions/unauthenticated"].includes(
      errorCode(e),
    )
      ? onDenied()
      : setError(message(e));
  useEffect(() => {
    let alive = true;
    setResources(null);
    setError("");
    setEditing(null);
    setSelected(null);
    services
      .call("listFacilityResources", { orgId, facilityId: facility.id })
      .then((result) => {
        if (alive) {
          setResources(result.items);
          setCursor(result.nextCursor);
        }
      })
      .catch((e) => {
        if (alive) failed(e);
      });
    return () => {
      alive = false;
    };
  }, [services, orgId, facility.id, version]);
  const saved = () => {
    epoch.current++;
    setVersion((n) => n + 1);
  };
  const map =
    facility.latitude !== null && facility.longitude !== null
      ? `${facility.latitude},${facility.longitude}`
      : facility.address;
  return (
    <section className="panel">
      <h2>{facility.name}: details and resources</h2>
      <p>{facility.address}</p>
      <p>Time zone: {facility.timeZone}</p>
      <p>
        <strong>Parking:</strong>{" "}
        {facility.parking || "Ask staff for parking information."}
      </p>
      <p>
        <strong>Accessibility:</strong>{" "}
        {facility.accessibility || "Ask staff for accessibility information."}
      </p>
      <a
        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(map)}`}
        target="_blank"
        rel="noreferrer"
      >
        Open map for {facility.name} (new tab)
      </a>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {resources === null && !error ? (
        <p role="status">Loading resources…</p>
      ) : resources?.length === 0 ? (
        <p>No fields or courts yet.</p>
      ) : (
        <ul>
          {resources?.map((r) => (
            <li key={r.id}>
              <h3>{r.label}</h3>
              <p>
                {r.status === "active" && facility.status === "active"
                  ? "Active resource; check interval availability before assigning."
                  : "Unavailable resource"}{" "}
                · {r.sports.join(", ")} · Setup {r.setupMinutes} min · Cleanup{" "}
                {r.cleanupMinutes} min
              </p>
              <button onClick={() => setSelected(r)}>
                Availability and assignment for {r.label}
              </button>
              {canManage && (
                <button onClick={() => setEditing(r)}>Edit {r.label}</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button
          onClick={() => {
            const request = epoch.current;
            void services
              .call("listFacilityResources", {
                orgId,
                facilityId: facility.id,
                cursor,
              })
              .then((result) => {
                if (request !== epoch.current) return;
                setResources((old) => [...(old || []), ...result.items]);
                setCursor(result.nextCursor);
              })
              .catch((e) => {
                if (request === epoch.current) failed(e);
              });
          }}
        >
          Load more resources
        </button>
      )}
      {canManage && (
        <button onClick={() => setEditing("new")}>New field or court</button>
      )}
      {canManage && editing && (
        <ResourceEditor
          key={typeof editing === "string" ? editing : editing.id}
          {...{ services, orgId, facility, onDenied }}
          item={editing === "new" ? null : editing}
          onSaved={saved}
        />
      )}
      {selected && (
        <ResourceAvailability
          key={`${selected.id}:${selected.revision}`}
          {...{ services, orgId, facility, canManage, onDenied }}
          resource={selected}
          onSaved={saved}
        />
      )}
    </section>
  );
}
function ResourceEditor({
  services,
  orgId,
  facility,
  item,
  onSaved,
  onDenied,
}: Props & {
  facility: Facility;
  item: Resource | null;
  onSaved: () => void;
  onDenied: () => void;
}) {
  const [fields, setFields] = useState<ResourceFields>(
    item || {
      label: "",
      sports: ["soccer"],
      setupMinutes: 0,
      cleanupMinutes: 0,
      status: "active",
    },
  );
  return (
    <section className="panel">
      <h3>{item ? "Edit resource" : "New field or court"}</h3>
      <Mutation
        {...{ onSaved, onDenied }}
        action={() => {
          const payload = {
            orgId,
            facilityId: facility.id,
            ...(item ? { resourceId: item.id } : {}),
            expectedRevision: item?.revision ?? 0,
            requestId: crypto.randomUUID(),
            fields: {
              label: fields.label,
              sports: fields.sports,
              setupMinutes: fields.setupMinutes,
              cleanupMinutes: fields.cleanupMinutes,
              status: fields.status,
            },
          };
          return () => services.call("saveFacilityResource", payload);
        }}
      >
        <label>
          Exact field or court label
          <input
            required
            value={fields.label}
            onChange={(e) => setFields({ ...fields, label: e.target.value })}
          />
        </label>
        <fieldset>
          <legend>Compatible sports</legend>
          {["soccer", "basketball", "football"].map((sport) => (
            <label key={sport}>
              <input
                type="checkbox"
                checked={fields.sports.includes(sport)}
                onChange={(e) =>
                  setFields({
                    ...fields,
                    sports: e.target.checked
                      ? [...fields.sports, sport]
                      : fields.sports.filter((s) => s !== sport),
                  })
                }
              />
              {sport}
            </label>
          ))}
        </fieldset>
        {(["setupMinutes", "cleanupMinutes"] as const).map((key) => (
          <label key={key}>
            {key === "setupMinutes" ? "Setup minutes" : "Cleanup minutes"}
            <input
              type="number"
              min="0"
              max="180"
              required
              value={fields[key]}
              onChange={(e) =>
                setFields({ ...fields, [key]: Number(e.target.value) })
              }
            />
          </label>
        ))}
        <label>
          Resource state
          <select
            value={fields.status}
            onChange={(e) =>
              setFields({
                ...fields,
                status: e.target.value as ResourceFields["status"],
              })
            }
          >
            <option value="active">Active</option>
            <option value="inactive">Unavailable</option>
          </select>
        </label>
      </Mutation>
    </section>
  );
}
function ResourceAvailability({
  services,
  orgId,
  facility,
  resource,
  canManage,
  onSaved,
  onDenied,
}: Props & {
  facility: Facility;
  resource: Resource;
  canManage: boolean;
  onSaved: () => void;
  onDenied: () => void;
}) {
  const epoch = useReadEpoch();
  const [items, setItems] = useState<Availability[] | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState("");
  const [effectiveFrom, setEffective] = useState(""),
    [windows, setWindows] = useState(""),
    [eventId, setEventId] = useState("");
  const [notice, setNotice] = useState("");
  const eventRequest = useRef(0);
  useEffect(
    () => () => {
      eventRequest.current++;
    },
    [],
  );
  const [loadingEvent, setLoadingEvent] = useState(false);
  const [loadedEvent, setLoadedEvent] = useState<{
    id: string;
    orgId: string;
    revision: number;
    title: string;
    canManage: boolean;
    location: { name: string } | null;
  } | null>(null);
  const failed = (e: unknown) =>
    ["functions/permission-denied", "functions/unauthenticated"].includes(
      errorCode(e),
    )
      ? onDenied()
      : setError(message(e));
  useEffect(() => {
    let alive = true;
    services
      .call("listResourceAvailability", {
        orgId,
        facilityId: facility.id,
        resourceId: resource.id,
      })
      .then((result) => {
        if (alive) {
          setItems(result.items);
          setCursor(result.nextCursor);
        }
      })
      .catch((e) => {
        if (alive) failed(e);
      });
    return () => {
      alive = false;
    };
  }, [services, orgId, facility.id, resource.id]);
  return (
    <section className="panel">
      <h3>{resource.label}: availability and assignment</h3>
      <p>
        Windows use explicit UTC instants. The facility time zone is{" "}
        {facility.timeZone}. Empty windows mean unavailable. Revisions are
        immutable and must take effect in the future.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {items === null && !error ? (
        <p role="status">Loading availability…</p>
      ) : items?.length === 0 ? (
        <p>Unavailable until an availability revision is added.</p>
      ) : (
        items?.map((item) => (
          <div key={item.id}>
            <h4>
              Revision {item.revision}, effective{" "}
              {formatDateTime(item.effectiveFrom, facility.timeZone)}
            </h4>
            {item.windows.length === 0 ? (
              <p>Unavailable from this revision.</p>
            ) : (
              <ul>
                {item.windows.map((w) => (
                  <li key={w.startsAt}>
                    {formatDateTime(w.startsAt, facility.timeZone)} to{" "}
                    {formatDateTime(w.endsAt, facility.timeZone)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
      {cursor && (
        <button
          onClick={() => {
            const request = epoch.current;
            void services
              .call("listResourceAvailability", {
                orgId,
                facilityId: facility.id,
                resourceId: resource.id,
                cursor,
              })
              .then((result) => {
                if (request !== epoch.current) return;
                setItems((old) => [...(old || []), ...result.items]);
                setCursor(result.nextCursor);
              })
              .catch((e) => {
                if (request === epoch.current) failed(e);
              });
          }}
        >
          Load older availability
        </button>
      )}
      {canManage && (
        <Mutation
          {...{ onSaved, onDenied }}
          label="Add availability revision"
          action={() => {
            const payload = {
              orgId,
              facilityId: facility.id,
              resourceId: resource.id,
              expectedRevision: resource.revision,
              requestId: crypto.randomUUID(),
              effectiveFrom,
              windows: windows.trim()
                ? windows
                    .trim()
                    .split("\n")
                    .map((line) => {
                      const [startsAt, endsAt] = line
                        .split(",")
                        .map((s) => s.trim());
                      return { startsAt, endsAt };
                    })
                : [],
            };
            return () => services.call("appendResourceAvailability", payload);
          }}
        >
          <label>
            Effective from (UTC)
            <input
              required
              placeholder="2026-11-01T00:00:00.000Z"
              value={effectiveFrom}
              onChange={(e) => setEffective(e.target.value)}
            />
          </label>
          <label>
            Availability windows (one UTC start,end pair per line)
            <textarea
              placeholder="2026-11-01T12:00:00.000Z,2026-11-01T23:00:00.000Z"
              value={windows}
              onChange={(e) => setWindows(e.target.value)}
            />
          </label>
        </Mutation>
      )}
      <h4>Assign an existing published event</h4>
      <p>
        Assignment checks your current authority for every team, compatible
        sports, availability and overlapping reservations. Setup and cleanup are
        included.
      </p>
      <label>
        Event ID
        <input
          value={eventId}
          onChange={(e) => {
            eventRequest.current++;
            setLoadingEvent(false);
            setEventId(e.target.value);
            setLoadedEvent(null);
          }}
        />
      </label>
      <button
        disabled={!eventId || loadingEvent}
        onClick={() => {
          setError("");
          setNotice("");
          setLoadedEvent(null);
          setLoadingEvent(true);
          const request = ++eventRequest.current;
          void services
            .call("getCanonicalEvent", { eventId })
            .then((row) => {
              if (request !== eventRequest.current) return;
              if (row.orgId !== orgId) {
                setError("Event unavailable in this organization.");
                return;
              }
              setLoadedEvent(row);
            })
            .catch((e) => {
              if (request !== eventRequest.current) return;
              if (
                ["functions/permission-denied", "functions/not-found"].includes(
                  errorCode(e),
                )
              )
                setError(
                  "Event unavailable. Check its ID and your event access; your facility view is still open.",
                );
              else setError(message(e));
            })
            .finally(() => {
              if (request === eventRequest.current) setLoadingEvent(false);
            });
        }}
      >
        Load event for assignment
      </button>
      {loadedEvent && (
        <>
          <p>
            {loadedEvent.title} · Current location:{" "}
            {loadedEvent.location?.name || "Unassigned"}
          </p>
          {loadedEvent.canManage ? (
            <Mutation
              onSaved={() => {
                setLoadedEvent(null);
                setNotice("Assignment saved.");
              }}
              onDenied={() => {
                setLoadedEvent(null);
                setError(
                  "Event assignment unavailable. Reload the event to recheck its current access.",
                );
              }}
              label={`Assign to ${resource.label}`}
              action={() => {
                const payload = {
                  eventId: loadedEvent.id,
                  expectedRevision: loadedEvent.revision,
                  requestId: crypto.randomUUID(),
                  action: "edit" as const,
                  patch: { facilityId: facility.id, resourceId: resource.id },
                  reason: "Staff resource assignment",
                };
                return () => services.call("mutateEventSchedule", payload);
              }}
            />
          ) : (
            <p>You cannot manage every team in this event.</p>
          )}
        </>
      )}
    </section>
  );
}
