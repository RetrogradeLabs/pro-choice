import { getDomainPageMetadata, renderDomainPage } from "@/lib/domain-page";

export async function generateMetadata() {
  return getDomainPageMetadata("cyber");
}

export default async function CyberPage() {
  return renderDomainPage("cyber");
}
