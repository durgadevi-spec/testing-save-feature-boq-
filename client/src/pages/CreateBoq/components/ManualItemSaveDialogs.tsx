import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Loader2, ArrowLeft, ArrowRight, GripVertical, ChevronsUpDown, Check } from "lucide-react";
import { computeBoq } from "@/lib/boqCalc";
import apiFetch from "@/lib/api";

// ── Drag-to-resize handle ───────────────────────────────────────────────
function ResizeHandle({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = containerRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = el.offsetWidth;
    const startH = el.offsetHeight;

    const onMouseMove = (ev: MouseEvent) => {
      const newW = Math.max(400, startW + (ev.clientX - startX) * 2); // *2 because dialog is centered with translate(-50%)
      const newH = Math.max(300, startH + (ev.clientY - startY) * 2);
      el.style.width = newW + "px";
      el.style.maxWidth = newW + "px";
      el.style.height = newH + "px";
      el.style.maxHeight = newH + "px";
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [containerRef]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className="absolute bottom-1 right-1 cursor-nwse-resize p-1 rounded hover:bg-slate-200/60 transition-colors z-50 select-none"
      title="Drag to resize"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" className="text-slate-400">
        <path d="M12 2L2 12M12 6L6 12M12 10L10 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}

// A "pending manual item" is a raw step11_items entry (manual: true) that
// has not yet been locked into a Save / Save As approval request.
export type PendingManualItem = {
  index: number; // original index in table_data.step11_items
  id?: string;
  title?: string;
  description?: string;
  unit?: string;
  qty?: number;
  qtyPerSqf?: number;
  supply_rate?: number;
  install_rate?: number;
  shop_name?: string;
  category?: string;
  [key: string]: any;
};

// ── Save (confirm) dialog ───────────────────────────────────────────────

export function SaveConfirmDialog({
  open,
  onOpenChange,
  productName,
  items,
  isSubmitting,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  items: PendingManualItem[];
  isSubmitting: boolean;
  onConfirm: () => void;
}) {
  const saveDialogRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={saveDialogRef} className="max-w-2xl min-h-[40vh] max-h-[85vh] overflow-hidden flex flex-col border-4 border-slate-200 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl font-black text-slate-800">Add Items to Existing Product?</DialogTitle>
          <DialogDescription className="text-base text-slate-500 mt-2">
            You have added <span className="font-bold text-primary">{items.length} new manual item{items.length === 1 ? "" : "s"}</span> to <span className="font-bold text-slate-700">{productName}</span>.
            <br />
            Do you want to add these items to the existing product and submit the changes for approval?
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto rounded-xl border-2 border-slate-200 divide-y bg-white shadow-inner min-h-0">
          {items.map((it) => (
            <div key={it.index} className="px-5 py-4 text-base flex items-center justify-between hover:bg-slate-50 transition-colors">
              <span className="font-bold text-slate-700">{it.title || it.description || "Untitled item"}</span>
              <span className="text-slate-400 font-semibold">{it.unit || ""}</span>
            </div>
          ))}
        </div>

        <DialogFooter className="mt-auto pt-4 border-t border-slate-100 flex items-center justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting} className="h-12 px-6 font-bold text-slate-600 border-2">Cancel</Button>
          <Button onClick={onConfirm} disabled={isSubmitting} className="h-12 px-8 font-black text-white bg-primary hover:bg-primary/90 shadow-md">
            {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Yes, Add & Submit
          </Button>
        </DialogFooter>
        <ResizeHandle containerRef={saveDialogRef} />
      </DialogContent>
    </Dialog>
  );
}

// ── Save As wizard dialog ───────────────────────────────────────────────

type ItemConfig = {
  selected: boolean;
  qty: number;
  wastagePct: number;
  supplyRate: number;
  installRate: number;
  freezeAndEdit: boolean;
};

export function SaveAsWizardDialog({
  open,
  onOpenChange,
  sourceProductName,
  items,
  isSubmitting,
  existingProductNames,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceProductName: string;
  items: PendingManualItem[];
  isSubmitting: boolean;
  existingProductNames: string[];
  onSubmit: (payload: { newProductName: string; selectedIndexes: number[]; items: any[]; calculatedResults: any }) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [newProductName, setNewProductName] = useState("");
  const [nameError, setNameError] = useState("");
  const [configByIndex, setConfigByIndex] = useState<Record<number, ItemConfig>>({});

  // ── Category / Subcategory (required for the new product being created) ──
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [subcategories, setSubcategories] = useState<string[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [loadingSubcategories, setLoadingSubcategories] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [subcategoryOpen, setSubcategoryOpen] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  const [subcategorySearch, setSubcategorySearch] = useState("");

  // Load the same category list used elsewhere in the app (Manage Product, etc.)
  useEffect(() => {
    if (!open) return;
    (async () => {
      setLoadingCategories(true);
      try {
        const res = await apiFetch("/api/material-categories");
        if (res.ok) {
          const d = await res.json();
          setCategories(Array.isArray(d.categories) ? d.categories : []);
        }
      } catch (err) {
        console.error("Failed to load categories:", err);
      } finally {
        setLoadingCategories(false);
      }
    })();
  }, [open]);

  // Load subcategories whenever the chosen category changes
  useEffect(() => {
    if (!category) { setSubcategories([]); return; }
    (async () => {
      setLoadingSubcategories(true);
      try {
        const res = await apiFetch(`/api/material-subcategories/${encodeURIComponent(category)}`);
        if (res.ok) {
          const d = await res.json();
          setSubcategories(Array.isArray(d.subcategories) ? d.subcategories : []);
        }
      } catch (err) {
        console.error("Failed to load subcategories:", err);
      } finally {
        setLoadingSubcategories(false);
      }
    })();
  }, [category]);

  const [dimA, setDimA] = useState<number | undefined>();
  const [dimB, setDimB] = useState<number | undefined>();
  const [dimC, setDimC] = useState<number | undefined>();
  const [requiredUnitType, setRequiredUnitType] = useState("Sqft");
  const [baseRequiredQty, setBaseRequiredQty] = useState(1);

  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());
  const [bulkQty, setBulkQty] = useState<string>("");
  const [bulkWastage, setBulkWastage] = useState<string>("");

  const applyBulkEdit = () => {
    if (bulkSelected.size === 0) return;
    setConfigByIndex(prev => {
      const next = { ...prev };
      bulkSelected.forEach(idx => {
        if (next[idx]) {
          next[idx] = { ...next[idx] };
          if (bulkQty.trim() !== "") next[idx].qty = Number(bulkQty) || 0;
          if (bulkWastage.trim() !== "") next[idx].wastagePct = Number(bulkWastage) || 0;
        }
      });
      return next;
    });
    setBulkQty("");
    setBulkWastage("");
    setBulkSelected(new Set()); // clear selection after apply
  };

  useEffect(() => {
    if (dimA !== undefined || dimB !== undefined || dimC !== undefined) {
      setBaseRequiredQty((Number(dimA) || 1) * (Number(dimB) || 1) * (Number(dimC) || 1));
    }
  }, [dimA, dimB, dimC]);

  const prevOpenRef = React.useRef(false);
  useEffect(() => {
    // Only reset when the dialog first opens (open transitions false → true).
    // This prevents parent re-renders (which create new `items` refs) from
    // resetting the wizard back to step 1 while the user is on step 2/3/4.
    if (!open) { prevOpenRef.current = false; return; }
    if (prevOpenRef.current) return;          // already open — skip reset
    prevOpenRef.current = true;
    setStep(1);
    setNewProductName("");
    setNameError("");
    setCategory("");
    setSubcategory("");
    setCategoryError("");
    setDimA(undefined);
    setDimB(undefined);
    setDimC(undefined);
    setRequiredUnitType("Sqft");
    setBaseRequiredQty(1);
    setBulkSelected(new Set());
    setBulkQty("");
    setBulkWastage("");
    const initial: Record<number, ItemConfig> = {};
    items.forEach((it) => {
      initial[it.index] = {
        selected: true,
        // qtyPerSqf is the per-unit qty from renderLines (engine-computed or manual)
        qty: Number(it.qtyPerSqf ?? it.qty ?? 0) || 0,
        wastagePct: Number(it.wastagePct) || 0,
        // renderLines stores rates as rateSqft (total rate), but individual supply/install
        // rates come from supply_rate / install_rate
        supplyRate: Number(it.supply_rate ?? (it as any).supplyRate ?? 0) || 0,
        installRate: Number(it.install_rate ?? (it as any).installRate ?? 0) || 0,
        freezeAndEdit: !!(it.freezeAndEdit || (it as any).freeze_and_edit),
      };
    });
    setConfigByIndex(initial);
  }, [open, items]);

  const selectedItems = useMemo(() => items.filter((it) => configByIndex[it.index]?.selected), [items, configByIndex]);

  // Reuse the existing calculation engine (client/src/lib/boqCalc.ts)
  const computedResults = useMemo(() => {
    return selectedItems.map((it) => {
      const cfg = configByIndex[it.index];
      const qty = Number(cfg?.qty) || 0;
      const result = computeBoq(
        { requiredUnitType: requiredUnitType, baseRequiredQty: baseRequiredQty, wastagePctDefault: cfg?.wastagePct || 0 },
        [{
          name: it.title,
          unit: it.unit,
          baseQty: qty,
          supplyRate: Number(cfg?.supplyRate) || 0,
          installRate: Number(cfg?.installRate) || 0,
          freezeAndEdit: cfg?.freezeAndEdit,
        }],
        baseRequiredQty
      );
      const line = result.computed[0];
      return { item: it, cfg, line };
    });
  }, [selectedItems, configByIndex, requiredUnitType, baseRequiredQty]);

  const grandTotal = computedResults.reduce((s, r) => s + (r.line?.lineTotal || 0), 0);

  const updateConfig = (index: number, patch: Partial<ItemConfig>) => {
    setConfigByIndex((prev) => ({ ...prev, [index]: { ...prev[index], ...patch } }));
  };

  const goNext = () => {
    if (step === 1) {
      const trimmed = newProductName.trim();
      if (!trimmed) { setNameError("Product name is required"); return; }
      if (existingProductNames.some((n) => n.trim().toLowerCase() === trimmed.toLowerCase())) {
        setNameError("A product with this name already exists in this BOM. Choose a different name.");
        return;
      }
      setNameError("");
      if (!category) { setCategoryError("Category is required"); return; }
      setCategoryError("");
    }
    if (step === 2 && selectedItems.length === 0) return;
    setStep((s) => (Math.min(4, s + 1) as 1 | 2 | 3 | 4));
  };
  const goBack = () => setStep((s) => (Math.max(1, s - 1) as 1 | 2 | 3 | 4));

  const handleSubmit = () => {
    const payload = {
      newProductName: newProductName.trim(),
      selectedIndexes: selectedItems.map((it) => it.index),
      items: computedResults.map(({ item, cfg, line }) => ({
        // Identity
        id: item.id || item.materialId,
        materialId: item.materialId || item.id,
        title: item.title || item.description,
        name: item.title || item.description,
        description: item.description || item.title,
        unit: item.unit,
        shop_name: item.shop_name,
        shop_id: item.shop_id,
        category: item.category,
        // Per-unit qty (the qty-per-base-unit configured in step 3)
        qty: cfg.qty,
        qtyPerSqf: cfg.qty,
        baseQty: cfg.qty,
        // Wastage & freeze settings
        wastagePct: cfg.wastagePct,
        freezeAndEdit: cfg.freezeAndEdit,
        applyWastage: true,
        applyRounding: true,
        // Rates
        supply_rate: cfg.supplyRate,
        install_rate: cfg.installRate,
        supplyRate: cfg.supplyRate,
        installRate: cfg.installRate,
        // Pre-computed amounts (for display / fallback)
        requiredQty: line?.roundOffQty ?? cfg.qty,
        roundOff: line?.roundOffQty ?? cfg.qty,
        amount: line?.lineTotal ?? 0,
      })),
      calculatedResults: {
        totalSupply: computedResults.reduce((s, r) => s + (r.line?.supplyAmount || 0), 0),
        totalInstall: computedResults.reduce((s, r) => s + (r.line?.installAmount || 0), 0),
        grandTotal,
      },
      productConfig: {
        dimA,
        dimB,
        dimC,
        requiredUnitType,
        baseRequiredQty,
        category,
        subcategory,
      }
    };
    onSubmit(payload);
  };

  const stepLabels = ["Product Name", "Select Items", "Calculation", "Review"];

  const wizardDialogRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={wizardDialogRef} className="w-[90vw] max-w-4xl max-h-[90vh] overflow-hidden flex flex-col border-4 border-slate-200 shadow-2xl p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="text-2xl font-black text-slate-800">
            {newProductName.trim() ? newProductName.trim() : "Save As New Product"}
          </DialogTitle>
          <DialogDescription className="text-base">
            Source Product: <span className="font-bold text-primary">{sourceProductName}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-sm font-bold text-slate-400 mb-2">
          {stepLabels.map((label, i) => (
            <React.Fragment key={label}>
              <span className={i + 1 === step ? "text-primary" : i + 1 < step ? "text-slate-600" : ""}>{i + 1}. {label}</span>
              {i < stepLabels.length - 1 && <span className="text-slate-300">›</span>}
            </React.Fragment>
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-5 mt-4">
            <div className="space-y-3">
              <Label htmlFor="new-product-name" className="text-sm font-bold uppercase text-slate-500">Product Name</Label>
              <Input
                id="new-product-name"
                placeholder="e.g. ABC Panelling Premium"
                className="h-12 text-lg font-bold border-2 border-slate-200 focus-visible:border-primary"
                value={newProductName}
                onChange={(e) => { setNewProductName(e.target.value); setNameError(""); }}
                autoFocus
              />
              {nameError && <p className="text-sm text-red-600 font-bold">{nameError}</p>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-sm font-bold uppercase text-slate-500">Category</Label>
                <Popover open={categoryOpen} onOpenChange={setCategoryOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      disabled={loadingCategories}
                      className="h-11 w-full justify-between font-bold border-2 border-slate-200"
                    >
                      <span className={category ? "" : "text-slate-400 font-normal"}>
                        {category || (loadingCategories ? "Loading..." : "Select category")}
                      </span>
                      <ChevronsUpDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent style={{ width: "var(--radix-popover-trigger-width)" }} className="p-0" align="start" side="bottom">
                    <Command shouldFilter={false}>
                      <CommandInput placeholder="Search category..." value={categorySearch} onValueChange={setCategorySearch} />
                      <CommandList className="max-h-[200px]">
                        <CommandEmpty>No categories found.</CommandEmpty>
                        <CommandGroup>
                          {categories
                            .filter(c => c.toLowerCase().includes(categorySearch.toLowerCase()))
                            .map((c) => (
                              <CommandItem
                                key={c}
                                value={c}
                                onSelect={() => { setCategory(c); setSubcategory(""); setCategoryError(""); setCategoryOpen(false); setCategorySearch(""); }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${category === c ? "opacity-100" : "opacity-0"}`} />
                                {c}
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-bold uppercase text-slate-500">Subcategory</Label>
                <Popover open={subcategoryOpen} onOpenChange={setSubcategoryOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      disabled={!category || loadingSubcategories}
                      className="h-11 w-full justify-between font-bold border-2 border-slate-200"
                    >
                      <span className={subcategory ? "" : "text-slate-400 font-normal"}>
                        {subcategory || (!category ? "Select category first" : loadingSubcategories ? "Loading..." : subcategories.length === 0 ? "No subcategories" : "Select subcategory")}
                      </span>
                      <ChevronsUpDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent style={{ width: "var(--radix-popover-trigger-width)" }} className="p-0" align="start" side="bottom">
                    <Command shouldFilter={false}>
                      <CommandInput placeholder="Search subcategory..." value={subcategorySearch} onValueChange={setSubcategorySearch} />
                      <CommandList className="max-h-[200px]">
                        <CommandEmpty>No subcategories found.</CommandEmpty>
                        <CommandGroup>
                          {subcategories
                            .filter(s => s.toLowerCase().includes(subcategorySearch.toLowerCase()))
                            .map((s) => (
                              <CommandItem
                                key={s}
                                value={s}
                                onSelect={() => { setSubcategory(s); setSubcategoryOpen(false); setSubcategorySearch(""); }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${subcategory === s ? "opacity-100" : "opacity-0"}`} />
                                {s}
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            {categoryError && <p className="text-sm text-red-600 font-bold">{categoryError}</p>}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3 mt-4 flex flex-col flex-1 min-h-0">
            <p className="text-base text-slate-500 font-medium">Choose which newly added manual items go into <span className="font-bold text-slate-800">{newProductName}</span>.</p>
            <div className="rounded-xl border-2 border-slate-200 divide-y flex-1 overflow-y-auto bg-white shadow-inner min-h-0">
              {items.map((it) => (
                <label key={it.index} className="flex items-center gap-4 px-4 py-3 text-base cursor-pointer hover:bg-slate-50 transition-colors">
                  <Checkbox
                    className="h-5 w-5 border-2"
                    checked={!!configByIndex[it.index]?.selected}
                    onCheckedChange={(v) => updateConfig(it.index, { selected: !!v })}
                  />
                  <span className="font-bold text-slate-700 flex-1">{it.title || it.description}</span>
                  <span className="text-slate-400 text-sm font-semibold">{it.unit}</span>
                </label>
              ))}
            </div>
            {selectedItems.length === 0 && <p className="text-sm text-red-600 font-bold">Select at least one item.</p>}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-2 mt-1 flex flex-col flex-1 min-h-0">
            <p className="text-sm text-slate-500 font-medium">Configure product dimensions and item quantities — same calculation logic as Manage Product.</p>

            {/* Product-level configuration and Bulk Edit Tools */}
            <div className="rounded-xl border-2 border-indigo-100 bg-indigo-50/50 p-2 px-3 shadow-sm flex flex-col lg:flex-row items-start lg:items-center gap-4">
              <p className="text-[10px] font-black uppercase text-indigo-400 tracking-wider w-16 shrink-0 leading-tight hidden lg:block">Product Config</p>
              <div className="flex flex-wrap items-center gap-4 flex-1">
                <div className="w-24">
                  <Label className="text-[10px] font-bold uppercase text-slate-500">Unit</Label>
                  <Select value={requiredUnitType} onValueChange={(v) => setRequiredUnitType(v)}>
                    <SelectTrigger className="h-7 text-xs font-bold border-2 border-slate-200 px-2 rounded-md">
                      <SelectValue placeholder="Sqft" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Sqft">Sqft</SelectItem>
                      <SelectItem value="Rft">Rft</SelectItem>
                      <SelectItem value="Pcs">Pcs</SelectItem>
                      <SelectItem value="Nos">Nos</SelectItem>
                      <SelectItem value="Rmt">Rmt</SelectItem>
                      <SelectItem value="Cum">Cum</SelectItem>
                      <SelectItem value="Ltrs">Ltrs</SelectItem>
                      <SelectItem value="Kgs">Kgs</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-16">
                  <Label className="text-[10px] font-bold uppercase text-slate-500">Dim A</Label>
                  <Input type="number" className="h-7 text-xs font-bold border-2 border-slate-200 px-2" value={dimA ?? ""} onChange={(e) => setDimA(e.target.value ? Number(e.target.value) : undefined)} placeholder="A" />
                </div>
                <div className="w-16">
                  <Label className="text-[10px] font-bold uppercase text-slate-500">Dim B</Label>
                  <Input type="number" className="h-7 text-xs font-bold border-2 border-slate-200 px-2" value={dimB ?? ""} onChange={(e) => setDimB(e.target.value ? Number(e.target.value) : undefined)} placeholder="B" />
                </div>
                <div className="w-16">
                  <Label className="text-[10px] font-bold uppercase text-slate-500">Dim C</Label>
                  <Input type="number" className="h-7 text-xs font-bold border-2 border-slate-200 px-2" value={dimC ?? ""} onChange={(e) => setDimC(e.target.value ? Number(e.target.value) : undefined)} placeholder="C" />
                </div>
                <div className="w-20">
                  <Label className="text-[10px] font-bold uppercase text-indigo-500">Req Qty</Label>
                  <Input type="number" className="h-7 text-xs font-black bg-white border-2 border-indigo-200 text-indigo-700 px-2" value={baseRequiredQty} onChange={(e) => setBaseRequiredQty(Number(e.target.value) || 1)} />
                </div>

                <div className="h-8 w-px bg-indigo-200 mx-1 hidden sm:block"></div>

                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-xs font-bold text-indigo-700 cursor-pointer">
                    <Checkbox
                      className="border-indigo-400 data-[state=checked]:bg-indigo-600 data-[state=checked]:border-indigo-600"
                      checked={bulkSelected.size === selectedItems.length && selectedItems.length > 0}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setBulkSelected(new Set(selectedItems.map(it => it.index)));
                        } else {
                          setBulkSelected(new Set());
                        }
                      }}
                    />
                    <span className="uppercase text-[10px]">Select All</span>
                  </label>
                  {bulkSelected.size > 0 && (
                    <>
                      <div className="h-4 w-px bg-indigo-200 mx-1"></div>
                      <div className="flex items-center gap-2 animate-in fade-in slide-in-from-left-2 duration-200">
                        <Input type="number" placeholder="Set Qty" className="h-7 w-20 text-xs font-bold bg-white border-2 border-indigo-200" value={bulkQty} onChange={e => setBulkQty(e.target.value)} />
                        <Input type="number" placeholder="Set Wastage %" className="h-7 w-28 text-xs font-bold bg-white border-2 border-indigo-200" value={bulkWastage} onChange={e => setBulkWastage(e.target.value)} />
                        <Button size="sm" className="h-7 text-xs font-bold px-4 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={bulkSelected.size === 0 || (bulkQty === "" && bulkWastage === "")} onClick={applyBulkEdit}>
                          Apply ({bulkSelected.size})
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-xl border-2 border-slate-200 divide-y flex-1 overflow-y-auto bg-white shadow-inner min-h-0">
              {selectedItems.map((it) => {
                const cfg = configByIndex[it.index];
                return (
                  <div key={it.index} className="px-3 py-2 flex items-center gap-3 hover:bg-slate-50 transition-colors">
                    <Checkbox
                      className="h-4 w-4 border-2"
                      checked={bulkSelected.has(it.index)}
                      onCheckedChange={(checked) => {
                        setBulkSelected(prev => {
                          const next = new Set(prev);
                          checked ? next.add(it.index) : next.delete(it.index);
                          return next;
                        });
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-sm text-slate-800 truncate" title={it.title || it.description}>{it.title || it.description}</div>
                    </div>
                    <div className="w-16 shrink-0">
                      <Label className="text-[10px] font-bold uppercase text-slate-500">Base Qty</Label>
                      <Input type="number" className="h-7 text-xs font-bold border-2 border-slate-200 px-2" value={cfg?.qty ?? 0} onChange={(e) => updateConfig(it.index, { qty: Number(e.target.value) || 0 })} />
                    </div>
                    <div className="w-16 shrink-0">
                      <Label className="text-[10px] font-bold uppercase text-slate-500">Wastage %</Label>
                      <Input type="number" className="h-7 text-xs font-bold border-2 border-slate-200 px-2" value={cfg?.wastagePct ?? 0} onChange={(e) => updateConfig(it.index, { wastagePct: Number(e.target.value) || 0 })} />
                    </div>
                    <div className="w-20 shrink-0 text-center">
                      <Label className="text-[10px] font-bold uppercase text-slate-500">Freeze</Label>
                      <div className="flex justify-center mt-1">
                        <Checkbox className="h-4 w-4 border-2 rounded-sm" checked={!!cfg?.freezeAndEdit} onCheckedChange={(v) => updateConfig(it.index, { freezeAndEdit: !!v })} />
                      </div>
                    </div>
                    <div className="w-20 shrink-0 text-right">
                      <Label className="text-[10px] font-bold uppercase text-slate-400 block mb-0.5">Rate</Label>
                      <div className="text-sm font-black text-slate-700">₹{((cfg?.supplyRate || 0) + (cfg?.installRate || 0)).toLocaleString()}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4 mt-2 flex flex-col flex-1 min-h-0">
            <div className="grid grid-cols-2 gap-4 text-sm bg-indigo-50/50 p-4 rounded-xl border-2 border-indigo-100">
              <div><span className="text-indigo-400 text-xs uppercase font-black tracking-wider">Source Product</span><div className="font-bold text-slate-700 text-base">{sourceProductName}</div></div>
              <div><span className="text-indigo-400 text-xs uppercase font-black tracking-wider">New Product</span><div className="font-bold text-slate-900 text-base">{newProductName}</div></div>
              <div><span className="text-indigo-400 text-xs uppercase font-black tracking-wider">Category</span><div className="font-bold text-slate-700 text-base">{category || "-"}</div></div>
              <div><span className="text-indigo-400 text-xs uppercase font-black tracking-wider">Subcategory</span><div className="font-bold text-slate-700 text-base">{subcategory || "-"}</div></div>
            </div>
            <div className="rounded-xl border-2 border-slate-200 divide-y flex-1 overflow-y-auto bg-white shadow-inner min-h-0">
              {computedResults.map(({ item, line }) => (
                <div key={item.index} className="px-4 py-3 flex items-center justify-between text-base hover:bg-slate-50 transition-colors">
                  <span className="font-bold text-slate-700">{item.title || item.description}</span>
                  <span className="text-slate-500 font-bold">₹{(line?.lineTotal ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between px-5 py-4 bg-slate-100 text-slate-800 border border-slate-200 rounded-xl font-black text-lg shadow-sm">
              <span className="uppercase tracking-widest text-sm text-slate-500">Calculated Grand Total</span>
              <span className="text-primary">₹{grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
          </div>
        )}

        <DialogFooter className="flex items-center justify-between sm:justify-between pt-2 shrink-0">
          <div>
            {step > 1 && (
              <Button variant="outline" onClick={goBack} disabled={isSubmitting}>
                <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>Cancel</Button>
            {step < 4 ? (
              <Button onClick={goNext} disabled={step === 2 && selectedItems.length === 0}>
                Next <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            ) : (
              <Button onClick={handleSubmit} disabled={isSubmitting} className="bg-primary text-white">
                {isSubmitting && <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />}
                Submit for Approval
              </Button>
            )}
          </div>
        </DialogFooter>
        <ResizeHandle containerRef={wizardDialogRef} />
      </DialogContent>
    </Dialog>
  );
}