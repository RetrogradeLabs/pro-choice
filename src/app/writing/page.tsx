import { getDomainPageMetadata, renderDomainPage } from "@/lib/domain-page";

export async function generateMetadata() {
  return getDomainPageMetadata("writing");
}

export default async function WritingPage() {
  return renderDomainPage("writing");
}
