/** User-facing copy. Kept in one place so tone stays consistent. */
export const AUDIT_ERRORS = {
  crossTenant: 'You are not authorized to access this resource.',
  noProject: 'That project does not exist.',
  noGallery: 'You are not authorized to access this gallery.',
  shareExpired: 'This gallery link has expired. Ask your photographer for a new one.',
  shareRevoked: 'This gallery link is no longer active.',
  notParticipant: 'You are not authorized to access this conversation.',
} as const;

export const BOOKING_ERRORS = {
  slotTaken: 'That date and time is no longer available. Please choose another slot.',
  notFound: 'That booking does not exist.',
  alreadyReviewed: 'This booking has already been reviewed.',
  cannotEdit: 'This booking can no longer be changed.',
} as const;

export const PAYMENT_ERRORS = {
  notFound: 'That payment record does not exist.',
  alreadyPaid: 'This booking has already been paid in full.',
  verificationFailed: 'We could not verify that payment with the gateway. Nothing was charged.',
  duplicate: 'That payment has already been recorded.',
  wrongAmount: 'The gateway reported a different amount than expected.',
  providerDisabled: 'That payment method is not available right now.',
} as const;

export const ALBUM_ERRORS = {
  notOpen: 'Album selection is not open for this album.',
  limitReached: 'You have already selected the maximum number of photos for this album.',
  completed: 'This album selection has already been submitted.',
  notYours: 'That photo is not part of this album.',
} as const;

export const COMMENT_ERRORS = {
  notFound: 'That comment does not exist.',
  notYours: 'You can only edit your own comments.',
} as const;

export const SHARE_ERRORS = {
  notFound: 'That gallery link does not exist.',
  limitReached: 'This link has reached its access limit. Create a new one to share again.',
  cannotRevokeLast: 'Revoke or delete the other links first - the client always needs one way in.',
} as const;

export const ADMIN_ERRORS = {
  noUser: 'That user does not exist.',
  noPhotographer: 'That photographer does not have a profile.',
  noInvoice: 'That invoice does not exist.',
} as const;

export const TESTIMONIAL_ERRORS = {
  notFound: 'That review does not exist.',
  notEligible: 'You can only review a photographer you have completed a shoot with.',
  wrongPhotographer: 'That project does not belong to this photographer.',
  duplicate: 'You have already reviewed this shoot.',
  alreadyApproved: 'That review is already published and can no longer be changed.',
} as const;

export const CHAT_ERRORS = {
  notFound: 'That conversation does not exist.',
  notYours: 'You can only edit your own messages.',
  notParticipant: 'You can only message people you have worked with.',
} as const;

export const INVOICE_ERRORS = {
  notFound: 'That invoice does not exist.',
  noBooking: 'That booking does not exist.',
  alreadyExists: 'An invoice has already been raised for this booking.',
  hasPayments: 'This invoice has payments recorded against it. Refund or adjust them before voiding.',
  overpayment: 'That is more than the outstanding balance.',
} as const;

export const PORTFOLIO_ERRORS = {
  notFound: 'That portfolio image does not exist.',
  notYours: 'That portfolio image is not yours to change.',
  noProfile: 'We could not find that photographer.',
} as const;

export const UPLOAD_ERRORS = {
  invalidType: 'Only JPG, PNG and WEBP images are accepted.',
  tooLarge: 'That image is too large.',
  tooMany: 'Too many files in one upload.',
  corrupt: 'That file is not a readable image.',
  missing: 'No image was uploaded.',
} as const;
