import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { Account } from "@shared/schema";
import { ACCOUNT_TYPES } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const TYPE_LABELS: Record<string, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  income: "Income",
  expense: "Expense",
};
const TYPE_COLORS: Record<string, string> = {
  asset: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  liability: "bg-chart-5/15 text-chart-5 border-chart-5/30",
  equity: "bg-chart-3/15 text-chart-3 border-chart-3/30",
  income: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  expense: "bg-chart-4/15 text-chart-4 border-chart-4/30",
};

export default function Accounts() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", type: "expense" as string, subtype: "" });

  const { data = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });

  const createMut = useMutation({
    mutationFn: async (body: typeof form) => {
      const r = await apiRequest("POST", "/api/accounts", {
        code: body.code,
        name: body.name,
        type: body.type,
        subtype: body.subtype || null,
        isActive: true,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/accounts"] });
      setOpen(false);
      setForm({ code: "", name: "", type: "expense", subtype: "" });
      toast({ title: "Account added" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const grouped = ACCOUNT_TYPES.map((t) => ({ type: t, accounts: data.filter((a) => a.type === t) }));

  return (
    <Layout>
      <PageHeader
        title="Chart of Accounts"
        description="Your business's bookkeeping categories"
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-new-account"><Plus className="h-4 w-4 mr-1.5" />New account</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>New account</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="code">Code</Label>
                    <Input id="code" placeholder="6800" data-testid="input-account-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
                  </div>
                  <div>
                    <Label htmlFor="type">Type</Label>
                    <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                      <SelectTrigger data-testid="select-account-type"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ACCOUNT_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label htmlFor="aname">Name</Label>
                  <Input id="aname" placeholder="Insurance Expense" data-testid="input-account-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="sub">Subtype (optional)</Label>
                  <Input id="sub" placeholder="operating_expense" data-testid="input-account-subtype" value={form.subtype} onChange={(e) => setForm({ ...form, subtype: e.target.value })} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button disabled={!form.code || !form.name || createMut.isPending} onClick={() => createMut.mutate(form)} data-testid="button-save-account">
                  {createMut.isPending ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="space-y-4">
        {grouped.map((g) => (
          <Card key={g.type}>
            <CardContent className="p-0">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/40">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={TYPE_COLORS[g.type]}>{TYPE_LABELS[g.type]}</Badge>
                  <span className="text-xs text-muted-foreground">{g.accounts.length} accounts</span>
                </div>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {g.accounts.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-account-${a.id}`}>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground w-20">{a.code}</td>
                      <td className="px-4 py-2.5 font-medium">{a.name}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{a.subtype || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))}
      </div>
    </Layout>
  );
}
