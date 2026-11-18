import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchTemplates, publishTemplate, type PolicyTemplate } from "@/lib/controlPlaneApi";
import { validatePolicy } from "@/lib/api";
import type { PolicyValidateResponse } from "@/types/api";
import { queryKeys } from "@/lib/queryKeys";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableLoading, TableError } from "@/components/shared/TableStates";
import { EmptyState } from "@/components/shared/EmptyState";
import { toast } from "sonner";
import { formatActor } from "@/lib/actor";
import { formatRelative } from "@/lib/time";
import { ValidationPanel } from "./PoliciesPage";

const PolicyEditor = lazy(() => import("./PolicyEditor"));

const VALIDATE_DEBOUNCE_MS = 350;
const TEMPLATE_PLACEHOLDER = 'e.g. policy "web" { allow if proto == "tcp" and port in [80, 443] }';
const EDITOR_CLASS = "font-mono text-xs border rounded w-full min-h-[200px]";

export default function TemplatesPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: queryKeys.templates(),
    queryFn: () => fetchTemplates(),
  });

  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [validation, setValidation] = useState<PolicyValidateResponse | null>(null);

  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!body.trim()) return;
    debounceRef.current = window.setTimeout(() => {
      validatePolicy(body)
        .then((out) => setValidation(out))
        .catch(() => setValidation(null));
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [body]);

  const shownValidation = body.trim() ? validation : null;
  const hasErrors = shownValidation ? !shownValidation.ok : false;

  const publish = useMutation({
    mutationFn: () => publishTemplate({ name: name.trim(), body }),
    onSuccess: () => {
      toast.success("Template published");
      setName("");
      setBody("");
      qc.invalidateQueries({ queryKey: queryKeys.templates() });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Templates</h1>
        <p className="text-sm text-muted-foreground">
          Named, reusable rule sets shared across the fleet. Templates published here are stored on
          the control plane; agents do not download them yet.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Published templates</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <TableLoading />}
          {isError && <TableError label={(error as Error).message} />}
          {!isLoading && !isError && (data ?? []).length === 0 && (
            <EmptyState title="No templates published yet." helpAnchor="templates">
              <p>
                A template is a named, reusable rule set. Publish one below. A container uses a
                template through the label <code>firefik.template=&lt;name&gt;</code> once the
                template is in its agent&apos;s templates file.
              </p>
            </EmptyState>
          )}
          {!isLoading && !isError && (data ?? []).length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2">Name</th>
                  <th>Version</th>
                  <th>Publisher</th>
                  <th>Updated</th>
                  <th>Labels</th>
                </tr>
              </thead>
              <tbody>
                {(data as PolicyTemplate[]).map((t) => (
                  <tr key={t.name} className="border-t">
                    <td className="py-2 font-mono">{t.name}</td>
                    <td>{t.version}</td>
                    <td className="text-xs" title={formatActor(t.publisher).title}>
                      {formatActor(t.publisher).label}
                    </td>
                    <td className="text-xs" title={new Date(t.updated_at).toLocaleString()}>
                      {formatRelative(t.updated_at)}
                    </td>
                    <td>
                      {t.labels &&
                        Object.entries(t.labels).map(([k, v]) => (
                          <Badge key={k} variant="secondary" className="mr-1">
                            {k}={v}
                          </Badge>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publish new template</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label htmlFor="template-name" className="block text-sm text-muted-foreground">
            Name
          </label>
          <input
            id="template-name"
            type="text"
            placeholder="template-name"
            className="w-full rounded border px-3 py-2 font-mono text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label
            id="template-body-label"
            htmlFor="template-body"
            className="block text-sm text-muted-foreground"
          >
            Rules (policy text)
          </label>
          <Suspense
            fallback={
              <div className={`${EDITOR_CLASS} p-2 text-muted-foreground`}>Loading editor…</div>
            }
          >
            <PolicyEditor
              id="template-body"
              ariaLabelledBy="template-body-label"
              ariaDescribedBy="template-body-check"
              placeholder={TEMPLATE_PLACEHOLDER}
              height="200px"
              value={body}
              onChange={(v) => setBody(v)}
              className={EDITOR_CLASS}
            />
          </Suspense>
          <div id="template-body-check" aria-live="polite">
            <ValidationPanel validation={shownValidation} />
          </div>
          <Button
            onClick={() => publish.mutate()}
            disabled={!name.trim() || !body.trim() || hasErrors || publish.isPending}
            title={hasErrors ? "Fix the errors in the policy text first." : undefined}
          >
            {publish.isPending ? "Publishing…" : "Publish"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
