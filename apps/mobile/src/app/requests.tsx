import { Redirect } from 'expo-router';

/** Keep installed notification/deep links working after moving Asks into Circle. */
export default function RequestsScreen() {
  return <Redirect href={{ pathname: '/friends', params: { section: 'requests' } }} />;
}
