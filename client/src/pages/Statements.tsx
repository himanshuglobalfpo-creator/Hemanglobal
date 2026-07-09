import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { fmtMoney, fmtDate, todayISO, startOfYearISO } from "@/lib/format";
import type { Customer, Vendor } from "@shared/schema";

export default function Statements() {
  return (
    <Layout>
      <PageHeader
        title="Statements"
        description="Per-customer and per-vendor activity statements with downloadable PDFs"
      />
      <Tabs defaultValue="customer">
        <TabsList>
          <TabsTrigger value="customer" data-testid="tab-customer-statement">Customer</TabsTrigger>
          <TabsTrigger value="vendor" data-testid="tab-vendor-statement">Vendor</TabsTrigger>
        </TabsList>
        <TabsContent value="customer" className="mt-4"><CustomerStatement /></TabsContent>
        <TabsContent value="vendor" className="mt-4"><VendorStatement /></TabsContent>
      </Tabs>
    </Layout>
  );
}

function CustomerStatement() {
  const { data: customers = [] } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [from, setFrom] = useState(startOfYearISO());
  const [to, setTo] = useState(todayISO());

  if (customerId == null && customers.length > 0) setCustomerId(customers[0].id);

  const { data } = useQuery<any>({
    queryKey: ["/api/reports/customer-statement", customerId, from, to],
    enabled: customerId != null,
    queryFn: async () =>
      (await apiRequest("GET", `/api/reports/customer-statement?customerId=${customerId}&from=${from}&to=${to}`)).json(),
  });

  const downloadUrl = customerId != null
    ? `/api/reports/customer-statement.pdf?customerId=${customerId}&from=${from}&to=${to}`
    : "";

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-end gap-3 mb-6 flex-wrap">
          <div className="min-w-[240px]">
            <Label>Customer</Label>
            <Select value={customerId?.toString() ?? ""} onValueChange={(v) => setCustomerId(Number(v))}>
              <SelectTrigger data-testid="select-statement-customer"><SelectValue placeholder="Select customer" /></SelectTrigger>
              <SelectContent>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div><Label>From</Label><Input type="date" data-testid="input-cust-stmt-from" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label>To</Label><Input type="date" data-testid="input-cust-stmt-to" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              disabled={!customerId}
              onClick={() => window.open(downloadUrl, "_blank")}
              data-testid="button-download-customer-statement"
            >
              <Download className="h-4 w-4 mr-2" />Download PDF
            </Button>
          </div>
        </div>

        {!data ? (
          <div className="p-12 text-center text-muted-foreground text-sm">
            {customers.length === 0 ? "Add a customer to view statements." : "Loading…"}
          </div>
        ) : (
          <StatementTable
            partyName={data.customer.name}
            partyEmail={data.customer.email}
            from={from}
            to={to}
            openingBalance={data.openingBalance}
            activity={data.activity}
            totalCharges={data.totalCharges}
            totalPayments={data.totalPayments}
            closingBalance={data.closingBalance}
            chargeHeader="Charge"
            paymentHeader="Payment"
          />
        )}
      </CardContent>
    </Card>
  );
}

function VendorStatement() {
  const { data: vendors = [] } = useQuery<Vendor[]>({ queryKey: ["/api/vendors"] });
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [from, setFrom] = useState(startOfYearISO());
  const [to, setTo] = useState(todayISO());

  if (vendorId == null && vendors.length > 0) setVendorId(vendors[0].id);

  const { data } = useQuery<any>({
    queryKey: ["/api/reports/vendor-statement", vendorId, from, to],
    enabled: vendorId != null,
    queryFn: async () =>
      (await apiRequest("GET", `/api/reports/vendor-statement?vendorId=${vendorId}&from=${from}&to=${to}`)).json(),
  });

  const downloadUrl = vendorId != null
    ? `/api/reports/vendor-statement.pdf?vendorId=${vendorId}&from=${from}&to=${to}`
    : "";

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-end gap-3 mb-6 flex-wrap">
          <div className="min-w-[240px]">
            <Label>Vendor</Label>
            <Select value={vendorId?.toString() ?? ""} onValueChange={(v) => setVendorId(Number(v))}>
              <SelectTrigger data-testid="select-statement-vendor"><SelectValue placeholder="Select vendor" /></SelectTrigger>
              <SelectContent>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id.toString()}>{v.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div><Label>From</Label><Input type="date" data-testid="input-vend-stmt-from" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label>To</Label><Input type="date" data-testid="input-vend-stmt-to" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              disabled={!vendorId}
              onClick={() => window.open(downloadUrl, "_blank")}
              data-testid="button-download-vendor-statement"
            >
              <Download className="h-4 w-4 mr-2" />Download PDF
            </Button>
          </div>
        </div>

        {!data ? (
          <div className="p-12 text-center text-muted-foreground text-sm">
            {vendors.length === 0 ? "Add a vendor to view statements." : "Loading…"}
          </div>
        ) : (
          <StatementTable
            partyName={data.vendor.name}
            partyEmail={data.vendor.email}
            from={from}
            to={to}
            openingBalance={data.openingBalance}
            activity={data.activity}
            totalCharges={data.totalCharges}
            totalPayments={data.totalPayments}
            closingBalance={data.closingBalance}
            chargeHeader="Bill"
            paymentHeader="Payment"
          />
        )}
      </CardContent>
    </Card>
  );
}

function StatementTable(props: {
  partyName: string;
  partyEmail: string | null;
  from: string;
  to: string;
  openingBalance: number;
  activity: Array<{ date: string; type: string; reference: string; description: string; charge: number; payment: number; balance: number }>;
  totalCharges: number;
  totalPayments: number;
  closingBalance: number;
  chargeHeader: string;
  paymentHeader: string;
}) {
  const { partyName, partyEmail, from, to, openingBalance, activity, totalCharges, totalPayments, closingBalance, chargeHeader, paymentHeader } = props;
  return (
    <>
      <div className="text-center mb-6">
        <h2 className="text-base font-semibold">{partyName}</h2>
        {partyEmail && <p className="text-xs text-muted-foreground">{partyEmail}</p>}
        <p className="text-xs text-muted-foreground mt-1">Period {fmtDate(from)} — {fmtDate(to)}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label="Opening" value={openingBalance} />
        <Stat label={`Total ${chargeHeader}s`} value={totalCharges} />
        <Stat label={`Total ${paymentHeader}s`} value={totalPayments} />
        <Stat label="Closing" value={closingBalance} highlight />
      </div>

      <table className="w-full text-sm">
        <thead className="border-b border-border bg-muted/40">
          <tr className="text-xs uppercase tracking-wide text-muted-foreground">
            <th className="text-left px-3 py-2 font-medium w-24">Date</th>
            <th className="text-left px-3 py-2 font-medium w-24">Ref</th>
            <th className="text-left px-3 py-2 font-medium">Description</th>
            <th className="text-right px-3 py-2 font-medium w-28">{chargeHeader}</th>
            <th className="text-right px-3 py-2 font-medium w-28">{paymentHeader}</th>
            <th className="text-right px-3 py-2 font-medium w-28">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border bg-muted/20">
            <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(from)}</td>
            <td colSpan={4} className="px-3 py-2 italic text-muted-foreground">Opening balance</td>
            <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtMoney(openingBalance)}</td>
          </tr>
          {activity.length === 0 && (
            <tr><td colSpan={6} className="px-3 py-12 text-center text-muted-foreground">No activity in this period.</td></tr>
          )}
          {activity.map((a, idx) => (
            <tr key={idx} className="border-b border-border/40">
              <td className="px-3 py-1.5 text-muted-foreground">{fmtDate(a.date)}</td>
              <td className="px-3 py-1.5 font-mono text-xs">{a.reference}</td>
              <td className="px-3 py-1.5">{a.description}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{a.charge ? fmtMoney(a.charge) : ""}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{a.payment ? fmtMoney(a.payment) : ""}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(a.balance)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-foreground font-semibold">
            <td colSpan={3} className="px-3 py-3">Totals</td>
            <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(totalCharges)}</td>
            <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(totalPayments)}</td>
            <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(closingBalance)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function Stat({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-md border border-border p-3 ${highlight ? "bg-primary/5 border-primary/30" : ""}`}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums mt-1 ${highlight ? "text-primary" : ""}`}>{fmtMoney(value)}</div>
    </div>
  );
}
