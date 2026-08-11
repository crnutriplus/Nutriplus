export type BarcodeKind = "UPC-A" | "UPC-E" | "EAN-8" | "EAN-13" | "GTIN-14";

export type BarcodeValidation = {
  valid: boolean;
  input: string;
  normalized: string | null;
  canonical: string | null;
  type: BarcodeKind | null;
  error: string | null;
  equivalents: string[];
};

function validGtinCheckDigit(value: string) {
  if (!/^\d+$/.test(value) || value.length < 2) return false;
  const expected = Number(value.at(-1));
  let sum = 0;
  let weight = 3;
  for (let index = value.length - 2; index >= 0; index -= 1) {
    sum += Number(value[index]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === expected;
}

function expandUpcE(value: string) {
  if (!/^\d{8}$/.test(value) || !["0", "1"].includes(value[0])) return null;
  const numberSystem = value[0];
  const [d1, d2, d3, d4, d5, d6] = value.slice(1, 7).split("");
  const check = value[7];
  let manufacturer = "";
  let product = "";
  if (["0", "1", "2"].includes(d6)) {
    manufacturer = `${d1}${d2}${d6}00`;
    product = `00${d3}${d4}${d5}`;
  } else if (d6 === "3") {
    manufacturer = `${d1}${d2}${d3}00`;
    product = `000${d4}${d5}`;
  } else if (d6 === "4") {
    manufacturer = `${d1}${d2}${d3}${d4}0`;
    product = `0000${d5}`;
  } else {
    manufacturer = `${d1}${d2}${d3}${d4}${d5}`;
    product = `0000${d6}`;
  }
  return `${numberSystem}${manufacturer}${product}${check}`;
}

function equivalentsFor(value: string, canonical: string) {
  const values = new Set<string>([value, canonical]);
  if (value.length === 12) values.add(`0${value}`);
  if (value.length === 13 && value.startsWith("0")) values.add(value.slice(1));
  if (value.length === 14) {
    const ean13 = value.slice(1);
    if (ean13.startsWith("0") && validGtinCheckDigit(ean13.slice(1))) values.add(ean13.slice(1));
    if (validGtinCheckDigit(ean13)) values.add(ean13);
  }
  return [...values];
}

export function validateBarcode(input: unknown): BarcodeValidation {
  const source = typeof input === "string" ? input.trim() : "";
  if (!source) return { valid: false, input: source, normalized: null, canonical: null, type: null, error: "Ingresá un código de barras.", equivalents: [] };
  if (!/^[\d\s-]+$/.test(source)) {
    return { valid: false, input: source, normalized: null, canonical: null, type: null, error: "El código de barras solo puede contener números, espacios o guiones.", equivalents: [] };
  }
  const value = source.replace(/[\s-]+/g, "");
  if (![8, 12, 13, 14].includes(value.length)) {
    return { valid: false, input: source, normalized: value, canonical: null, type: null, error: "El código debe tener 8, 12, 13 o 14 dígitos.", equivalents: [] };
  }

  let type: BarcodeKind | null = value.length === 12 ? "UPC-A" : value.length === 13 ? "EAN-13" : value.length === 14 ? "GTIN-14" : null;
  let valid = validGtinCheckDigit(value);
  if (value.length === 8) {
    const expanded = expandUpcE(value);
    if (expanded && validGtinCheckDigit(expanded)) {
      type = "UPC-E";
      valid = true;
    } else {
      type = "EAN-8";
    }
  }
  if (!valid) {
    return { valid: false, input: source, normalized: value, canonical: null, type, error: "El dígito de control del código no es válido.", equivalents: [] };
  }
  const canonical = value.padStart(14, "0");
  return { valid: true, input: source, normalized: value, canonical, type, error: null, equivalents: equivalentsFor(value, canonical) };
}

export function barcodeEquivalent(left: unknown, right: unknown) {
  const a = validateBarcode(left);
  const b = validateBarcode(right);
  return Boolean(a.valid && b.valid && a.canonical === b.canonical);
}

export function barcodeCandidates(input: unknown) {
  const validated = validateBarcode(input);
  return validated.valid ? validated.equivalents : [];
}
