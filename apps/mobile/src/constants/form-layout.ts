/** Shared geometry for full-width form controls; chips and badges stay compact. */
export const FormLayout = {
  controlHeight: 50,
  controlRadius: 16,
  horizontalPadding: 16,
  verticalPadding: 12,
  sectionGap: 12,
  sectionSpacing: 24,
  dividerPadding: 16,
} as const;

export const formControlStyle = {
  minHeight: FormLayout.controlHeight,
  borderRadius: FormLayout.controlRadius,
  paddingHorizontal: FormLayout.horizontalPadding,
  paddingVertical: FormLayout.verticalPadding,
} as const;

export const formSectionStyle = { gap: FormLayout.sectionGap } as const;
