export const APP_TOUR_VERSION = 1;
export const APP_TOUR_STEP_COUNT = 6;
export type TourIllustration = 'circle' | 'request' | 'limits' | 'reward' | 'customize' | 'login';
export type TourActivity = 'friends' | 'customize';
export type TourSlide = { id: TourIllustration; title: string; body: string; note: string; activity?: TourActivity };

/** Personal app limits are separate from the server's extra-time request limits. */
export function appTourSlides(platform: string): readonly TourSlide[] {
  return [
    {
      id: 'circle', title: 'Add your friends',
      body: 'Share your code in Circle',
      note: 'Friends can approve or deny requests',
      activity: 'friends',
    },
    {
      id: 'request', title: 'Ask for time',
      body: platform === 'web' ? 'Request 5, 10, 15 or 30 minutes' : 'Request 15 or 30 extra minutes',
      note: platform === 'android' ? 'Android needs Usage Access and Accessibility'
        : platform === 'ios' ? 'Uses Screen Time access to limit apps'
          : 'Browsers cannot block or unlock phone apps',
    },
    {
      id: 'limits', title: 'Your daily limit',
      body: 'Choose apps to limit in the Screen Time tab',
      note: 'Choose between a shared or separate budget for app limits',
    },
    {
      id: 'reward', title: 'Earn s’mores',
      body: 'No requests from everyone for a whole day earns one s’more',
      note: 'Sending a request will burn the marshmallow! It doesn’t matter if it gets approved or rejected',
    },
    {
      id: 'customize', title: 'Choose your look',
      body: 'Customize your camper from Camp',
      note: 'Unlock hats, colors and shared campsites',
      activity: 'customize',
    },
    {
      id: 'login', title: 'Keep your login key',
      body: 'Save your private key in Setup',
      note: 'Already have an account? Enter its key to restore it',
    },
  ];
}
