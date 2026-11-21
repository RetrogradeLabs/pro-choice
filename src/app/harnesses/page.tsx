import { getDomainPageMetadata, renderDomainPage } from "@/lib/domain-page";

export async function generateMetadata() {
  return getDomainPageMetadata("harnesses");
}

export default async function HarnessesPage() {
  return renderDomainPage("harnesses");
}
