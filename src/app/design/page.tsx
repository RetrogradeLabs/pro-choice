import { getDomainPageMetadata, renderDomainPage } from "@/lib/domain-page";

export async function generateMetadata() {
  return getDomainPageMetadata("design_code");
}

export default async function DesignPage() {
  return renderDomainPage("design_code");
}
