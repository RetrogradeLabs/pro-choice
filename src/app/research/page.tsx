import { getDomainPageMetadata, renderDomainPage } from "@/lib/domain-page";

export async function generateMetadata() {
  return getDomainPageMetadata("research");
}

export default async function ResearchPage() {
  return renderDomainPage("research");
}
