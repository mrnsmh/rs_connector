"""
URL configuration for rsconnector project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path
from django.views.generic.base import RedirectView
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from deskshared.checks import run_all_checks, compute_overall


@api_view(['GET'])
@permission_classes([AllowAny])
def health_full(request):
    checks = run_all_checks()
    overall = compute_overall(checks)
    return Response({"overall": overall, "checks": checks})


from hub.admin_views import AdminAuthView, AdminGoogleView, AdminLogoutView


urlpatterns = [
    path('console/', admin.site.urls),
    path('health', lambda request: JsonResponse({'status': 'ok', 'service': 'rs-connector-django'})),
    path('health/full/', health_full),
    # Auth SPA
    path('admin', AdminAuthView.as_view()),
    path('admin/', AdminAuthView.as_view()),
    path('admin/google', AdminGoogleView.as_view()),
    path('admin/logout', AdminLogoutView.as_view()),
    # Racine -> admin Django sur /console (coexiste avec le /admin du back-office Node).
    path('', RedirectView.as_view(url='/console/', permanent=False)),
    path('', include('hub.urls')),
]
