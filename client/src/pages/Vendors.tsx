import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import type { Vendor } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function Vendors() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", address: "", notes: "" });

  const { data = [] } = useQuery<Vendor[]>({ queryKey: ["/api/vendors"] });

  const createMut = useMutation({
    mutationFn: async (body: typeof form) => {
      const r = await apiRequest("POST", "/api/vendors", {
        name: body.name,
        email: body.email || null,
        phone: body.phone || null,
        address: body.address || null,
        notes: body.notes || null,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors"] });
      setOpen(false);
      setForm({ name: "", email: "", phone: "", address: "", notes: "" });
      toast({ title: "Vendor added" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/vendors/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/vendors"] }),
  });

  return (
    <Layout>
      <PageHeader
        title="Vendors"
        description="Suppliers and contractors you pay"
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-new-vendor"><Plus className="h-4 w-4 mr-1.5" />New vendor</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>New vendor</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="vname">Name</Label>
                  <Input id="vname" data-testid="input-vendor-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="vemail">Email</Label>
                    <Input id="vemail" data-testid="input-vendor-email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  </div>
                  <div>
                    <Label htmlFor="vphone">Phone</Label>
                    <Input id="vphone" data-testid="input-vendor-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                  </div>
                </div>
                <div>
                  <Label htmlFor="vaddr">Address</Label>
                  <Textarea id="vaddr" data-testid="input-vendor-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button disabled={!form.name || createMut.isPending} onClick={() => createMut.mutate(form)} data-testid="button-save-vendor">
                  {createMut.isPending ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium w-12"></th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                    No vendors yet. Add one to start tracking bills.
                  </td>
                </tr>
              )}
              {data.map((v) => (
                <tr key={v.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-vendor-${v.id}`}>
                  <td className="px-4 py-3 font-medium">{v.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{v.email || "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{v.phone || "—"}</td>
                  <td className="px-4 py-3">
                    <Button variant="ghost" size="icon" onClick={() => delMut.mutate(v.id)} data-testid={`button-delete-vendor-${v.id}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </Layout>
  );
}
