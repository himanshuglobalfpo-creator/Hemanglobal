import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import type { Customer } from "@shared/schema";
import { useOpenOnCreateParam } from "@/lib/create-shortcut";
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

export default function Customers() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  useOpenOnCreateParam(() => setOpen(true)); // global "+ Create → Add customer"
  const [form, setForm] = useState({ name: "", email: "", phone: "", address: "", notes: "" });

  const { data = [] } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });

  const createMut = useMutation({
    mutationFn: async (body: typeof form) => {
      const r = await apiRequest("POST", "/api/customers", {
        name: body.name,
        email: body.email || null,
        phone: body.phone || null,
        address: body.address || null,
        notes: body.notes || null,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      setOpen(false);
      setForm({ name: "", email: "", phone: "", address: "", notes: "" });
      toast({ title: "Customer added" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/customers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/customers"] }),
  });

  return (
    <Layout>
      <PageHeader
        title="Customers"
        description="People and companies you invoice"
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-new-customer"><Plus className="h-4 w-4 mr-1.5" />New customer</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New customer</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" data-testid="input-customer-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" data-testid="input-customer-email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  </div>
                  <div>
                    <Label htmlFor="phone">Phone</Label>
                    <Input id="phone" data-testid="input-customer-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                  </div>
                </div>
                <div>
                  <Label htmlFor="addr">Address</Label>
                  <Textarea id="addr" data-testid="input-customer-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button
                  disabled={!form.name || createMut.isPending}
                  onClick={() => createMut.mutate(form)}
                  data-testid="button-save-customer"
                >
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
                    No customers yet. Add one to start invoicing.
                  </td>
                </tr>
              )}
              {data.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-customer-${c.id}`}>
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.email || "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.phone || "—"}</td>
                  <td className="px-4 py-3">
                    <Button variant="ghost" size="icon" onClick={() => delMut.mutate(c.id)} data-testid={`button-delete-customer-${c.id}`}>
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
